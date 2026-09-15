const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.deleteMany({
    where: { emailVerified: false }
  });
  console.log(`Deleted ${users.count} unverified users.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
