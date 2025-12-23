import { StoreOverview } from "../store";

export interface AdminOverviewData {
  quickStats: any;
  salesActivity: any;
  joinRequests: any;
  supportTickets: any;
  allStores: StoreOverview[];
}