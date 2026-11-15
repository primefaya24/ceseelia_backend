import { StoreOverview } from "../store";
import { AdminOverviewStats } from "../../admin-stats";

/* GET /admin/get-overview-data (L.8 / 8.1). */
export interface AdminOverviewData {
  stats: AdminOverviewStats;
  allStores: StoreOverview[];
}
