import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { sendWeeklyDigests } from "../modules/notifications/digest.service";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly — sendWeeklyDigests itself decides who's actually due

export default fp(async function notificationsSchedulerPlugin(app: FastifyInstance) {
  const runCheck = () => {
    sendWeeklyDigests(app)
      .then(({ sent }) => {
        if (sent > 0) app.log.info({ sent }, "Sent weekly progress digests");
      })
      .catch((err) => app.log.error(err, "Weekly digest run failed"));
  };

  runCheck(); // once on boot, same rationale as uploadsRetention.ts's sweep
  const interval = setInterval(runCheck, CHECK_INTERVAL_MS);
  app.addHook("onClose", (_instance, done) => {
    clearInterval(interval);
    done();
  });
});
