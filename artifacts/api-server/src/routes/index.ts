import { Router, type IRouter } from "express";
import healthRouter from "./health";
import studentRouter from "./student";
import topicsRouter from "./topics";
import scheduleRouter from "./schedule";
import sessionsRouter from "./sessions";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(studentRouter);
router.use(topicsRouter);
router.use(scheduleRouter);
router.use(sessionsRouter);
router.use(dashboardRouter);

export default router;
