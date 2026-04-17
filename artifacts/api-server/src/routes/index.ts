import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studentRouter from "./student";
import topicsRouter from "./topics";
import scheduleRouter from "./schedule";
import sessionsRouter from "./sessions";
import dashboardRouter from "./dashboard";
import analyticsRouter from "./analytics";
import aiRouter from "./ai";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studentRouter);
router.use(topicsRouter);
router.use(scheduleRouter);
router.use(sessionsRouter);
router.use(dashboardRouter);
router.use(analyticsRouter);
router.use(aiRouter);

export default router;
