import { SqliteSettingsRepo } from "./settings-repo.js";

/**
 * Default settings seeded on first run.
 * Source: CLAUDE.md §7 and Handoff 3.4.
 *
 * Uses insertIfAbsent() so existing user values are never overwritten.
 */
const DEFAULTS: Record<string, string> = {
  // Address of the Xenia on the local network — set MACHINE_IP before the first start.
  machine_ip: process.env.MACHINE_IP ?? "192.168.1.100",
  polling_idle_ms: "1000",
  polling_brew_ms: "250",
  brew_by_weight_active: "false",
  brew_by_weight_window_ms: "1000",
  brew_by_weight_residual_lag_s: "1.35",
  brew_by_weight_auto_calibrate: "true",
  // BBW safety watchdog (Spec §4.12 / Auftrag 3m) — re-fires the stop when the
  // machine ACKs but does not actuate (FW actuation bug, diagnosis 3k). On by
  // default: it is the safety net. Conservative thresholds.
  brew_by_weight_watchdog_enabled: "true",
  brew_by_weight_watchdog_stop_lag_ms: "3000",
  brew_by_weight_watchdog_overshoot_g: "7",
  // Brühgruppe→Brühboiler 1:1-Kopplung. Bewusst NICHT im Settings-UI sichtbar
  // (kein ALLOWED/GET/Toggle) — umschaltbar nur per DB. Backend liest live.
  brew_group_boiler_coupling: "true",
  // Post-Brew-Tracking (Spec §4.12) — Defaults erfassen typischen Nachtropfen
  post_brew_max_duration_ms: "5000",
  post_brew_stable_delta_g: "0.1",
  post_brew_stable_window_ms: "1000",
  // Reserved for future down-sampling. Recorder currently saves every frame.
  sample_interval_ms: "250",
  active_bean_id: "null",
  active_grinder_id: "null",
  visualizer_api_key: "null",
  // Chart X-axis behaviour
  chart_x_window_s: "30",       // sliding-window width in seconds
  chart_x_slide_step_s: "10",   // how many seconds each slide step advances xMin
  chart_x_resize_on_end: "true", // zoom to full shot duration when shot ends
  chart_x_resize_animation: "true", // animate the end-of-shot resize
  show_script_overlay: "false",  // SO-1: opt-in Soll-vs-Ist overlay in shot detail (default off)
  show_pump_curve: "false",      // opt-in measured pump-power (%) curve in shot detail (default off)
  show_stage_markers: "false",   // opt-in Flow-Hold stage markers + Soll staircase in shot detail (default off)
  // Shot recording optional fields (Step 8)
  show_tds_input: "false",       // show TDS + EY% fields in post-shot review
  // Bean editor section visibility (Step 8.5) — which optional sections
  // of the BeanEditor are shown. Hidden sections never overwrite stored data.
  bean_fields_origin: "true",
  bean_fields_inventory: "true",
  bean_fields_aroma: "true",
  bean_fields_freeze_dates: "true",
  // Pre-shot dialog field visibility (Step 9). Bean is always shown — it is
  // the most important pre-shot context — so it has no toggle.
  preshot_field_grinder: "true",
  preshot_field_grind_setting: "true",
  preshot_field_grinder_rpm: "true",
  preshot_field_dose: "true",
  preshot_field_profile_notes: "true",

  // Rückspül-Reminder (backflush). backflush_baseline_at is seeded to "now" in
  // seedSettings (Null-Fall), not here, since it needs a dynamic timestamp.
  backflush_reminder_enabled: "true",
  backflush_reminder_days: "14",
  backflush_script_ids: "",
  backflush_snooze_until: "",
};

export function seedSettings(): void {
  const repo = new SqliteSettingsRepo();
  for (const [key, value] of Object.entries(DEFAULTS)) {
    repo.insertIfAbsent(key, value);
  }
  // Backflush baseline seeds to install time (Null-Fall) so the reminder only
  // fires once the interval has elapsed from first start, not immediately.
  repo.insertIfAbsent("backflush_baseline_at", String(Date.now()));
}
