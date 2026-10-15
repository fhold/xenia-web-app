import { SqliteSettingsRepo } from "./db/settings-repo.js";

export interface AppConfig {
  machineIp: string;
  pollingIdleMs: number;
  pollingBrewMs: number;
  brewByWeightActive: boolean;
  brewByWeightDelayG: number;
  brewByWeightWindowMs: number;
}

/**
 * Load config from the settings table.
 * Falls back to hardcoded defaults if the DB isn't seeded yet.
 */
export function loadConfig(): AppConfig {
  const repo = new SqliteSettingsRepo();
  const map = repo.getAll();

  return {
    // The stored setting wins (changed in Settings → Maschine); MACHINE_IP only
    // seeds it on the very first start (seed.ts).
    machineIp: map.get("machine_ip") ?? process.env.MACHINE_IP ?? "192.168.1.100",
    pollingIdleMs: parseInt(map.get("polling_idle_ms") ?? "1000", 10),
    pollingBrewMs: parseInt(map.get("polling_brew_ms") ?? "250", 10),
    brewByWeightActive: map.get("brew_by_weight_active") === "true",
    brewByWeightDelayG: parseFloat(map.get("brew_by_weight_delay_g") ?? "0.5"),
    brewByWeightWindowMs: parseInt(
      map.get("brew_by_weight_window_ms") ?? "1500",
      10,
    ),
  };
}
