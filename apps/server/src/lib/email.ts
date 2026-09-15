import nodemailer, { type Transporter } from "nodemailer";
import { env, isEmailConfigured } from "../config/env";

/**
 * Thin wrapper around Nodemailer's SMTP transport. Deliberately the only
 * function anything else calls to send mail — swapping SMTP for Resend/
 * SendGrid later is a rewrite of this one file, not every call site.
 */
export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!isEmailConfigured()) {
    throw new Error(
      "SMTP is not configured — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM (see .env.example)",
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    });
  }
  return transporter;
}

export async function sendMail({ to, subject, html }: SendMailInput): Promise<void> {
  await getTransporter().sendMail({ from: env.SMTP_FROM, to, subject, html });
}

/**
 * Shared shell for both templates below — same persona-adjacent, friendly
 * tone as the rest of the product (not the full PROMPT.md persona; this is
 * transactional mail, not a tutoring turn).
 */
function otpEmailShell(headline: string, code: string, bodyLine: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #0f766e;">ShikkhaAI</h2>
      <p style="font-size: 16px;">${headline}</p>
      <p style="font-size: 14px; color: #444;">${bodyLine}</p>
      <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; text-align: center; margin: 24px 0; color: #0f766e;">
        ${code}
      </div>
      <p style="font-size: 13px; color: #888;">This code expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
}

export function verificationEmail(code: string): { subject: string; html: string } {
  return {
    subject: "Verify your ShikkhaAI email address",
    html: otpEmailShell(
      "Welcome to ShikkhaAI! Please verify your email to unlock chat and mastery checks.",
      code,
      "Enter this code in the app to confirm it's really you.",
    ),
  };
}

export function passwordResetEmail(code: string): { subject: string; html: string } {
  return {
    subject: "Your ShikkhaAI password reset code",
    html: otpEmailShell(
      "We received a request to reset your ShikkhaAI password.",
      code,
      "Enter this code in the app to choose a new password.",
    ),
  };
}
