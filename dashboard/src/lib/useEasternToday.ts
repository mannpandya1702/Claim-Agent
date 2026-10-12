import { useEffect, useState } from "react";
import { etDayKey } from "./format";

/**
 * The current Eastern day ("YYYY-MM-DD"). It changes at midnight ET, so a page that derives its
 * date range from it rolls "Today" and "Last 7 days" over without a reload, and every page that
 * uses it moves at the same moment (tiles and lists keep agreeing).
 */
export function useEasternToday(): string {
  const [day, setDay] = useState(() => etDayKey(new Date()));
  useEffect(() => {
    const t = setInterval(() => setDay(etDayKey(new Date())), 60_000);
    return () => clearInterval(t);
  }, []);
  return day;
}
