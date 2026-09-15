import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sendMail, verificationEmail, passwordResetEmail } from "../../lib/email";
import { isEmailConfigured } from "../../config/env";

const OTP_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

export type OtpPurpose = "VERIFY_EMAIL" | "RESET_PASSWORD";

function generateCode(): string {
  // 6 digits, zero-padded — crypto.randomInt is uniform, unlike Math.random.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Invalidates any outstanding codes of this purpose for the user (so a
 * resend can't leave multiple valid codes live), issues a fresh one, and
 * emails it. Callers decide what "user" means for their flow (see
 * auth.routes.ts) — this function only knows userId + email + purpose.
 */
export async function issueOtp(
  app: FastifyInstance,
  userId: string,
  email: string,
  purpose: OtpPurpose,
): Promise<void> {
  const code = generateCode();

  await app.prisma.$transaction([
    app.prisma.otpCode.updateMany({
      where: { userId, purpose, consumed: false },
      data: { consumed: true },
    }),
    app.prisma.otpCode.create({
      data: {
        userId,
        purpose,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    }),
  ]);

  // SMTP is optional at the env layer (see config/env.ts) so the server can
  // still boot and be exercised locally without a real mailbox configured.
  // In that case, log the code instead of silently discarding it — never
  // let the caller believe an email actually went out.
  if (!isEmailConfigured()) {
    app.log.warn(`SMTP not configured — ${purpose} OTP for ${email} is: ${code}`);
    return;
  }

  const template = purpose === "VERIFY_EMAIL" ? verificationEmail(code) : passwordResetEmail(code);
  await sendMail({ to: email, ...template });
}

export type VerifyOtpResult = "OK" | "INVALID" | "EXPIRED" | "LOCKED";

/**
 * Checks a submitted code against the latest unconsumed OTP of this purpose
 * for the user. On a wrong guess, increments `attempts` and locks the code
 * out (LOCKED) once MAX_ATTEMPTS is reached — the caller should tell the
 * user to request a new code rather than keep guessing the same one.
 * On success, marks it consumed so it can't be replayed.
 */
export async function verifyOtp(
  app: FastifyInstance,
  userId: string,
  purpose: OtpPurpose,
  submittedCode: string,
): Promise<VerifyOtpResult> {
  const otp = await app.prisma.otpCode.findFirst({
    where: { userId, purpose, consumed: false },
    orderBy: { createdAt: "desc" },
  });

  if (!otp) {
    return "INVALID";
  }
  if (otp.expiresAt < new Date()) {
    return "EXPIRED";
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    return "LOCKED";
  }

  const matches = hashCode(submittedCode) === otp.codeHash;
  if (!matches) {
    await app.prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    return otp.attempts + 1 >= MAX_ATTEMPTS ? "LOCKED" : "INVALID";
  }

  await app.prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumed: true },
  });
  return "OK";
}
