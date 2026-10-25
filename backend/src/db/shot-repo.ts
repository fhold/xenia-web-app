import { getDb } from "./index.js";
import { brewDefHash, canonicalBrewDef, type BrewDefKind } from "./brew-def.js";
import type { GhostBasis, GhostSourceSample } from "../../../shared/src/shot-ghosts.js";
import type { NetShot } from "../../../shared/src/network.js";
import type {
  Shot,
  NewShot,
  Sample,
  StopMode,
  ShotCategory,
  GrindNote,
  ChannelingSeverity,
  VsPrev,
  ShotCompare,
  TasteTag,
  BrewType,
  RecentShot,
  ShotListItem,
  ShotSortKey,
  ShotUpdate,
  ShotStage,
  BrewProfile,
  ShotSize,
} from "../../../shared/src/types.js";

/** Parse the `taste_tags` JSON column into a string array (null-safe). */
function parseTasteTags(raw: string | null): TasteTag[] | null {
  if (raw === null || raw === "") return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as TasteTag[]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Input for appendSample() — matches shot_sample columns. */
export interface SampleInput {
  elapsedMs: number;
  pressureBar: number | null;
  flowMlS: number | null;
  flowMeterMl: number | null;
  tempBgC: number | null;
  tempBbC: number | null;
  weightG: number | null;
  /** Pump power level % (PU_LEVEL_PW_CONTROL). For deriving power↔pressure. */
  pumpPwm: number | null;
  /** Brew sub-phase: 'preinfusion' (before full pressure builds) / 'extraction'
   *  (MA_STATUS=3, pressure has reached EXTRACTION_PRESSURE_BAR) / 'post_brew'
   *  (post-brew tracking). Spec §4.12. */
  phase: "preinfusion" | "extraction" | "post_brew";
}

/** Per-shot stop snapshot written at finalize time. Spec §4.12. */
export interface ShotStopSnapshot {
  stopTriggerWeightG: number | null;
  flowAtTriggerGPerS: number | null;
  residualLagSUsed: number | null;
  bbwLeftBrewingLagMs: number | null;
  postBrewDurationMs: number | null;
  postBrewStopReason: "stable" | "timeout" | null;
  /** Machine reported a frozen/constant implausible weight the whole brew. */
  scaleFrozen?: boolean;
  /** The scale dropped out mid-brew (see scale-stall.ts). */
  scaleLost?: boolean;
}

/** A stored brew definition (brew_def row). */
export interface BrewDef {
  hash: string;
  kind: BrewDefKind;
  content: string;
  firstSeenAt: number;
}

/** Input for appendStageTransitions() — matches shot_stage columns. */
export interface ShotStageInput {
  stageIndex: number;
  stepKind: "flow" | "pressure" | "power";
  targetFlowGs: number | null;
  targetPressureBar: number | null;
  targetPower: number | null;
  exitReason: "seconds" | "weightG" | "pressureBar" | "pressureBelowBar" | "flowGs" | "flowAboveGs" | "arrived" | null;
  enteredMs: number;
}

/** What the driver reports per stage. The entry time is absolute because the
 *  driver and the recorder have different origins: the driver starts on the
 *  brew command, the recorder when the machine reports brewing (1-2 s later).
 *  The recorder rebases this onto shot.startedAt, the axis the samples use. */
export interface StageTransition extends Omit<ShotStageInput, "enteredMs"> {
  enteredAt: number;
}

/** Input for logAutoCalibration() — matches auto_calibration_log columns. */
export interface AutoCalibrationEntry {
  shotId: number;
  createdAt: number;
  oldLagS: number;
  newLagS: number;
  weightErrorG: number;
  flowAtTriggerGPerS: number;
  calibrationApplied: boolean;
}

/** Filter + sort + pagination for the history list (listShotsFiltered). */
export interface ShotListFilter {
  limit: number;
  offset: number;
  sort: ShotSortKey;
  /** 'all' means no category filter. */
  category: ShotCategory | "all";
  beanId?: number;
  grinderId?: number;
  profileId?: number;
  basketId?: number;
  /** Schnitt 4: alle Roestungen einer Sorte; die gelaufene Variante. */
  coffeeId?: number;
  variantId?: number;
  /** Exact shot rating 1–5. */
  rating?: number;
  /** Inclusive lower/upper bound on started_at (unix ms). */
  startMs?: number;
  endMs?: number;
  /** Nur diese Bezuege (Vorschlaege zum Vergleichen). */
  ids?: number[];
}

/** Which past shots to pull in as ghosts, and how the group is defined. */
export interface GhostCandidateQuery {
  /** The shot the ghosts are drawn behind — never its own ghost. */
  excludeShotId: number;
  /** "brewdef" matches brew_def_hash (provably the same ablauf), "profile" the profile id. */
  basis: GhostBasis;
  /** The hash or the profile id, matching `basis`. */
  key: string | number;
  /** Ignore stubs — a shot with a handful of samples is noise, not a ghost. */
  minSamples: number;
  limit: number;
  /**
   * 1× and 2× never share a cloud. Usually the hash separates them by itself
   * (two slots = two scripts = two definitions), but a profile whose 2×-slot
   * is not configured reuses the 1× sequence — same content, same hash, other
   * yield target. And the profile fallback would mix them unconditionally.
   */
  shotSize: ShotSize;
  /** Hat der Bezug ein Sieb, teilen nur Bezuege mit demselben Sieb die Wolke
   *  (zwei 1er-Siebe oder das HE-Sieb mischen sich sonst unter „1×“). */
  basketId?: number | null;
}

export interface ShotRepo {
  createShot(input: NewShot): number;
  appendSample(shotId: number, sample: SampleInput): void;
  finalizeShot(
    shotId: number,
    endedAt: number,
    stopMode: StopMode,
    yieldActualG: number | null,
    snapshot?: ShotStopSnapshot,
  ): void;
  /** Appends one BBW auto-calibration audit row. Spec §4.12. */
  logAutoCalibration(entry: AutoCalibrationEntry): void;
  /** Persists the Flow-Hold stage transitions of a shot (append-only, once at
   *  finalize). No-op for an empty list (script/execute shots). */
  appendStageTransitions(shotId: number, stages: ShotStageInput[]): void;
  /** The Flow-Hold stages a shot ran, in entry order. Empty for non-drive shots. */
  listStages(shotId: number): ShotStage[];
  /** The brew_steps JSON snapshot of a shot (parsed), or null. */
  getBrewStepsSnapshot(shotId: number): BrewProfile | null;
  /**
   * Store a brew definition in canonical form (phase names dropped) under its
   * content hash (first writer wins) and return that hash, for
   * `NewShot.brewDefHash`.
   */
  rememberBrewDef(kind: BrewDefKind, content: string): string;
  /** The stored brew definition for a hash, or null. */
  getBrewDef(hash: string): BrewDef | null;
  findById(id: number): Shot | undefined;
  listSamples(shotId: number): Sample[];
  /**
   * Ids of the past shots to draw as ghosts behind `excludeShotId`, newest
   * first. Excludes maintenance runs, shots that lost the scale mid-brew
   * (their weight/flow is deliberately zeroed) and stubs with too few samples.
   */
  /**
   * Bisher benutzte Freitext-Bohnen, zuletzt benutzte zuerst, mit Anzahl.
   * Speist das Autocomplete — und der Zähler ist nebenbei der Hinweis, wann
   * eine "Fremdbohne" doch eine gepflegte Sorte werden sollte.
   */
  beanLabelSuggestions(): { label: string; count: number; lastUsedAt: number }[];
  listGhostCandidates(p: GhostCandidateQuery): number[];
  /** Pressure/flow sample rows for several shots at once, shot by shot. */
  listGhostSamples(ids: number[]): Map<number, GhostSourceSample[]>;
  /**
   * Filtered + sorted + paginated history list with joined profile/bean/
   * grinder names. Returns the page plus the unpaginated total.
   */
  listShotsFiltered(filter: ShotListFilter): { shots: ShotListItem[]; total: number };
  /** Patch-updates the editable fields of a shot. Returns false if no such shot. */
  updateShot(id: number, patch: ShotUpdate): boolean;
  /** Hard-deletes a shot (samples cascade). Returns false if no such shot. */
  deleteShot(id: number): boolean;
  /** Returns the shot with ended_at IS NULL, if any. At most one in normal operation. */
  findActive(): Shot | undefined;
  /**
   * Startup reconcile: finalize EVERY still-open shot (ended_at IS NULL) by
   * setting ended_at + stop_mode. Conservative — touches no measurement columns
   * (yield etc. stay as recorded). Returns the number of rows finalized.
   */
  finalizeAllOpen(endedAt: number, stopMode: StopMode): number;
  /**
   * Most recent shot matching the given filters (AND-combined), or undefined.
   * At least one filter must be set. Used for pre-shot dialog prefill.
   * `withDose` additionally skips shots with no recorded dose.
   */
  findLast(filter: {
    beanId?: number; grinderId?: number; profileId?: number; basketId?: number; withDose?: boolean;
  }): Shot | undefined;
  /**
   * §3.4b pre-shot cascade — Sorte stage. Newest shot of ANY roasting of the
   * given coffee (optionally constrained to one grinder). Used when the new
   * roasting itself has no shots yet (re-purchase case).
   */
  findLastByCoffee(filter: {
    coffeeId: number; grinderId?: number; withDose?: boolean;
  }): Shot | undefined;
  /**
   * The most recent brew-category shots, newest first, with joined
   * profile/bean/grinder names. For the dashboard's recent-shots section.
   */
  listRecentBrew(limit: number): RecentShot[];
  /** Schnitt 4: Startpunkt fuer neue Bohnen — juengster Bezug mit Profil + Sieb + Muehle und einer Sorte gleichen Roestgrads wie `beanId`. */
  findLastSameRoast(filter: { beanId: number; profileId: number; basketId: number; grinderId: number }): Shot | undefined;
  /** Schnitt 4: beendete Bezuege fuer das Netz Profil ↔ Bohne. */
  listNetworkShots(filter: { coffeeId?: number; profileId?: number }): NetShot[];
  /** Bewertung: der letzte beendete Bezug derselben Sorte vor diesem; null ohne Sorte. */
  findPreviousSameCoffee(id: number): ShotCompare["previous"];
  /** Vergleich: die Referenz ★ derselben Sorte, ausser dieser Bezug ist es selbst. */
  findReferenceSameCoffee(id: number): number | null;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

export class SqliteShotRepo implements ShotRepo {
  createShot(input: NewShot): number {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO shot
           (profile_id, profile_name, profile_set_temp_c, script_id, shot_size, category, started_at,
            yield_target_g, has_cmd27, cmd27_value,
            bean_id, bean_label, grinder_id, grind_setting, grinder_rpm, dose_g, notes, brew_steps,
            brew_def_hash, variant_id, basket_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.profileId,
        input.profileName ?? null,
        input.profileSetTempC ?? null,
        input.scriptId,
        input.shotSize,
        input.category,
        input.startedAt,
        input.yieldTargetG ?? null,
        input.hasCmd27 ? 1 : 0,
        input.cmd27Value ?? null,
        input.beanId ?? null,
        input.beanLabel ?? null,
        input.grinderId ?? null,
        input.grindSetting ?? null,
        input.grinderRpm ?? null,
        input.doseG ?? null,
        input.notes ?? null,
        input.brewSteps ? JSON.stringify(input.brewSteps) : null,
        input.brewDefHash ?? null,
        input.variantId ?? null,
        input.basketId ?? null,
      ) as { lastInsertRowid: number };
    return result.lastInsertRowid;
  }

  rememberBrewDef(kind: BrewDefKind, raw: string): string {
    const content = canonicalBrewDef(kind, raw);
    const hash = brewDefHash(kind, content);
    getDb()
      .prepare(
        `INSERT INTO brew_def (hash, kind, content, first_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(hash, kind, content, Date.now());
    return hash;
  }

  getBrewDef(hash: string): BrewDef | null {
    const row = getDb()
      .prepare("SELECT hash, kind, content, first_seen_at FROM brew_def WHERE hash = ?")
      .get(hash) as
      | { hash: string; kind: BrewDefKind; content: string; first_seen_at: number }
      | undefined;
    if (!row) return null;
    return {
      hash: row.hash,
      kind: row.kind,
      content: row.content,
      firstSeenAt: row.first_seen_at,
    };
  }

  appendSample(shotId: number, sample: SampleInput): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO shot_sample
         (shot_id, elapsed_ms, pressure_bar, flow_ml_s, flow_meter_ml,
          temp_bg_c, temp_bb_c, weight_g, pump_pwm, phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      shotId,
      sample.elapsedMs,
      sample.pressureBar ?? null,
      sample.flowMlS ?? null,
      sample.flowMeterMl ?? null,
      sample.tempBgC ?? null,
      sample.tempBbC ?? null,
      sample.weightG ?? null,
      sample.pumpPwm ?? null,
      sample.phase,
    );
  }

  finalizeShot(
    shotId: number,
    endedAt: number,
    stopMode: StopMode,
    yieldActualG: number | null,
    snapshot?: ShotStopSnapshot,
  ): void {
    const db = getDb();
    db.prepare(
      `UPDATE shot
       SET ended_at = ?, stop_mode = ?, yield_actual_g = ?,
           stop_trigger_weight_g = ?, flow_at_trigger_g_per_s = ?,
           residual_lag_s_used = ?, bbw_left_brewing_lag_ms = ?,
           post_brew_duration_ms = ?, post_brew_stop_reason = ?,
           scale_frozen = ?, scale_lost = ?
       WHERE id = ?`,
    ).run(
      endedAt,
      stopMode,
      yieldActualG ?? null,
      snapshot?.stopTriggerWeightG ?? null,
      snapshot?.flowAtTriggerGPerS ?? null,
      snapshot?.residualLagSUsed ?? null,
      snapshot?.bbwLeftBrewingLagMs ?? null,
      snapshot?.postBrewDurationMs ?? null,
      snapshot?.postBrewStopReason ?? null,
      snapshot?.scaleFrozen ? 1 : 0,
      snapshot?.scaleLost ? 1 : 0,
      shotId,
    );
  }

  logAutoCalibration(entry: AutoCalibrationEntry): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO auto_calibration_log
         (shot_id, created_at, old_lag_s, new_lag_s,
          weight_error_g, flow_at_trigger_g_per_s, calibration_applied)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.shotId,
      entry.createdAt,
      entry.oldLagS,
      entry.newLagS,
      entry.weightErrorG,
      entry.flowAtTriggerGPerS,
      entry.calibrationApplied ? 1 : 0,
    );
  }

  appendStageTransitions(shotId: number, stages: ShotStageInput[]): void {
    if (stages.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO shot_stage
         (shot_id, stage_index, step_kind, target_flow_gs, target_pressure_bar,
          target_power, exit_reason, entered_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of stages) {
      stmt.run(
        shotId,
        s.stageIndex,
        s.stepKind,
        s.targetFlowGs ?? null,
        s.targetPressureBar ?? null,
        s.targetPower ?? null,
        s.exitReason ?? null,
        s.enteredMs,
      );
    }
  }

  listStages(shotId: number): ShotStage[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT stage_index, step_kind, target_flow_gs, target_pressure_bar,
                target_power, exit_reason, entered_ms
           FROM shot_stage WHERE shot_id = ? ORDER BY stage_index ASC`,
      )
      .all(shotId) as unknown as RawShotStageRow[];
    return rows.map((r) => ({
      stageIndex: r.stage_index,
      stepKind: r.step_kind,
      targetFlowGs: r.target_flow_gs,
      targetPressureBar: r.target_pressure_bar,
      targetPower: r.target_power,
      exitReason: r.exit_reason,
      enteredMs: r.entered_ms,
    }));
  }

  getBrewStepsSnapshot(shotId: number): BrewProfile | null {
    const db = getDb();
    const row = db
      .prepare("SELECT brew_steps FROM shot WHERE id = ?")
      .get(shotId) as { brew_steps: string | null } | undefined;
    if (!row || row.brew_steps === null || row.brew_steps === "") return null;
    try {
      return JSON.parse(row.brew_steps) as BrewProfile;
    } catch {
      return null;
    }
  }

  findById(id: number): Shot | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM shot WHERE id = ?")
      .get(id) as unknown as RawShotRow | undefined;
    return row ? toShot(row) : undefined;
  }

  listSamples(shotId: number): Sample[] {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM shot_sample WHERE shot_id = ? ORDER BY elapsed_ms ASC",
      )
      .all(shotId) as unknown as RawSampleRow[];
    return rows.map(toSample);
  }

  beanLabelSuggestions(): { label: string; count: number; lastUsedAt: number }[] {
    // Case-insensitiv zusammenfassen, aber die ZULETZT benutzte Schreibweise
    // anzeigen: sonst zerfaellt "Gatuya" und "gatuya" in zwei Vorschlaege und
    // genau die Gruppierung geht kaputt, wegen der es das Feld gibt.
    const rows = getDb()
      .prepare(
        `SELECT bean_label AS label, COUNT(*) AS n, MAX(started_at) AS last
           FROM shot
          WHERE category = 'brew' AND bean_label IS NOT NULL AND TRIM(bean_label) != ''
          GROUP BY LOWER(TRIM(bean_label))
          ORDER BY last DESC`,
      )
      .all() as unknown as { label: string; n: number; last: number }[];
    return rows.map((r) => ({ label: r.label, count: r.n, lastUsedAt: r.last }));
  }

  listGhostCandidates(p: GhostCandidateQuery): number[] {
    const db = getDb();
    // A shot that lost the scale has its yield zeroed on purpose — its weight
    // and (scale-derived) flow would drag the whole cloud to the floor.
    const rows = db
      .prepare(
        `SELECT id FROM shot
          WHERE id != ?
            AND ended_at IS NOT NULL
            AND category = 'brew'
            AND COALESCE(scale_lost, 0) = 0
            AND ${p.basketId != null ? "basket_id = ?" : "shot_size = ?"}
            AND ${p.basis === "brewdef" ? "brew_def_hash = ?" : "profile_id = ?"}
            AND (SELECT COUNT(*) FROM shot_sample s WHERE s.shot_id = shot.id) >= ?
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(p.excludeShotId, p.basketId != null ? p.basketId : p.shotSize, p.key, p.minSamples, p.limit) as unknown as { id: number }[];
    return rows.map((r) => r.id);
  }

  listGhostSamples(ids: number[]): Map<number, GhostSourceSample[]> {
    const out = new Map<number, GhostSourceSample[]>();
    if (ids.length === 0) return out;
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT shot_id, elapsed_ms, pressure_bar, flow_ml_s
           FROM shot_sample
          WHERE shot_id IN (${ids.map(() => "?").join(",")})
          ORDER BY shot_id ASC, elapsed_ms ASC`,
      )
      .all(...ids) as unknown as {
        shot_id: number;
        elapsed_ms: number;
        pressure_bar: number | null;
        flow_ml_s: number | null;
      }[];
    for (const r of rows) {
      let list = out.get(r.shot_id);
      if (!list) {
        list = [];
        out.set(r.shot_id, list);
      }
      list.push({
        elapsedMs: r.elapsed_ms,
        pressureBar: r.pressure_bar,
        flowMlS: r.flow_ml_s,
      });
    }
    return out;
  }

  listShotsFiltered(filter: ShotListFilter): { shots: ShotListItem[]; total: number } {
    const db = getDb();
    const conds: string[] = [];
    const params: (string | number)[] = [];

    if (filter.category !== "all") { conds.push("s.category = ?");  params.push(filter.category); }
    if (filter.beanId !== undefined)    { conds.push("s.bean_id = ?");    params.push(filter.beanId); }
    if (filter.grinderId !== undefined) { conds.push("s.grinder_id = ?"); params.push(filter.grinderId); }
    if (filter.profileId !== undefined) { conds.push("s.profile_id = ?"); params.push(filter.profileId); }
    if (filter.basketId !== undefined)  { conds.push("s.basket_id = ?");  params.push(filter.basketId); }
    if (filter.coffeeId !== undefined)  { conds.push("s.bean_id IN (SELECT id FROM bean WHERE coffee_id = ?)"); params.push(filter.coffeeId); }
    if (filter.variantId !== undefined) { conds.push("s.variant_id = ?"); params.push(filter.variantId); }
    if (filter.rating !== undefined)    { conds.push("s.rating = ?");     params.push(filter.rating); }
    if (filter.startMs !== undefined)   { conds.push("s.started_at >= ?"); params.push(filter.startMs); }
    if (filter.endMs !== undefined)     { conds.push("s.started_at <= ?"); params.push(filter.endMs); }
    if (filter.ids !== undefined)       { conds.push(`s.id IN (${filter.ids.map(() => "?").join(", ") || "NULL"})`); params.push(...filter.ids); }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS n FROM shot s ${where}`)
      .get(...params) as { n: number };

    let orderBy: string;
    switch (filter.sort) {
      case "date_asc": orderBy = "s.started_at ASC"; break;
      // Highest rating first; unrated (NULL) shots sink to the bottom.
      case "rating":   orderBy = "s.rating IS NULL, s.rating DESC, s.started_at DESC"; break;
      // 'c.name IS NULL' pushes shots without a bean to the bottom. The name
      // lives on coffee (§3.4b), joined as c below.
      case "bean":     orderBy = "c.name IS NULL, c.name ASC, s.started_at DESC"; break;
      case "date_desc":
      default:         orderBy = "s.started_at DESC";
    }

    const rows = db
      .prepare(
        `SELECT s.id, s.profile_id,
                CASE WHEN p.name IS NOT NULL THEN p.name
                     WHEN s.profile_name IS NOT NULL THEN s.profile_name || ' (Profil gelöscht)'
                     ELSE '(Profil gelöscht)' END AS profile_name,
                s.shot_size, s.category, s.variant_id, s.basket_id,
                s.started_at, s.ended_at, s.yield_target_g, s.yield_actual_g, s.stop_mode, s.rating, s.notes,
                s.bean_id, s.bean_label, c.name AS bean_name, c.roaster AS bean_roaster,
                c.brew_type AS bean_brew_type,
                s.grinder_id, g.name AS grinder_name,
                s.grind_setting, s.grinder_rpm, s.dose_g, s.tds_percent, s.profile_set_temp_c,
                s.acidity, s.bitterness, s.extraction_under, s.extraction_over, s.channeling, s.channeling_severity,
                s.vs_prev, s.vs_prev_shot_id, s.taste_tags, s.grind_note,
                CASE WHEN bb.shot_id IS NOT NULL THEN 1 ELSE 0 END AS is_best_brew
         FROM shot s
         LEFT JOIN profile p ON p.id = s.profile_id
         LEFT JOIN bean b ON b.id = s.bean_id
         LEFT JOIN coffee c ON c.id = b.coffee_id
         LEFT JOIN grinder g ON g.id = s.grinder_id
         LEFT JOIN best_brew bb ON bb.shot_id = s.id
         ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as unknown as RawShotListRow[];

    return { shots: rows.map(toShotListItem), total: totalRow.n };
  }

  updateShot(id: number, patch: ShotUpdate): boolean {
    const db = getDb();
    // Only these fields are editable — non-editable columns (shot_size,
    // timestamps, stop_mode, …) are simply not in this whitelist.
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (patch.basketId !== undefined) {
      // shot_size folgt dem Siebtyp (HE zaehlt als Einzel) — sonst mischten sich
      // 1× und 2× wieder in Geisterkurven und Wiederholen.
      fields.push("basket_id = ?", "shot_size = (SELECT CASE type WHEN 'double' THEN 'double' ELSE 'single' END FROM basket WHERE id = ?)");
      values.push(patch.basketId, patch.basketId);
    }
    if (patch.beanId !== undefined)       { fields.push("bean_id = ?");       values.push(patch.beanId); }
    if (patch.beanLabel !== undefined)    { fields.push("bean_label = ?");    values.push(patch.beanLabel); }
    if (patch.grinderId !== undefined)    { fields.push("grinder_id = ?");    values.push(patch.grinderId); }
    if (patch.grindSetting !== undefined) { fields.push("grind_setting = ?"); values.push(patch.grindSetting); }
    if (patch.grinderRpm !== undefined)   { fields.push("grinder_rpm = ?");   values.push(patch.grinderRpm); }
    if (patch.doseG !== undefined)        { fields.push("dose_g = ?");        values.push(patch.doseG); }
    if (patch.tdsPercent !== undefined)   { fields.push("tds_percent = ?");   values.push(patch.tdsPercent); }
    if (patch.rating !== undefined)       { fields.push("rating = ?");        values.push(patch.rating); }
    if (patch.acidity !== undefined)      { fields.push("acidity = ?");           values.push(patch.acidity); }
    if (patch.bitterness !== undefined)   { fields.push("bitterness = ?");        values.push(patch.bitterness); }
    if (patch.extractionUnder !== undefined) { fields.push("extraction_under = ?"); values.push(patch.extractionUnder ? 1 : 0); }
    if (patch.extractionOver !== undefined)  { fields.push("extraction_over = ?");  values.push(patch.extractionOver ? 1 : 0); }
    if (patch.channeling !== undefined)      { fields.push("channeling = ?");       values.push(patch.channeling ? 1 : 0); }
    // Staerke und Marke haengen zusammen: eine Staerke ohne Channeling gibt es
    // nicht, und wer Channeling abschaltet, loescht die Staerke mit. Genau hier
    // erzwungen, damit kein Aufrufer einen Widerspruch speichern kann.
    if (patch.channelingSeverity !== undefined && patch.channelingSeverity !== null) {
      fields.push("channeling_severity = ?"); values.push(patch.channelingSeverity);
      if (patch.channeling === undefined) { fields.push("channeling = ?"); values.push(1); }
    } else if (patch.channelingSeverity === null || patch.channeling === false) {
      fields.push("channeling_severity = ?"); values.push(null);
    }
    // Urteil und Vergleichsbezug haengen zusammen: ohne Urteil kein Bezug.
    if (patch.vsPrev !== undefined) {
      fields.push("vs_prev = ?", "vs_prev_shot_id = ?");
      values.push(patch.vsPrev, patch.vsPrev === null ? null : (patch.vsPrevShotId ?? null));
    }
    if (patch.tasteTags !== undefined)    { fields.push("taste_tags = ?");    values.push(patch.tasteTags === null ? null : JSON.stringify(patch.tasteTags)); }
    if (patch.grindNote !== undefined)    { fields.push("grind_note = ?");    values.push(patch.grindNote); }
    if (patch.notes !== undefined)        { fields.push("notes = ?");         values.push(patch.notes); }

    if (fields.length === 0) {
      // Empty patch — report only whether the shot exists.
      return db.prepare("SELECT 1 FROM shot WHERE id = ?").get(id) !== undefined;
    }

    values.push(id);
    const result = db
      .prepare(`UPDATE shot SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values) as { changes: number };
    return result.changes > 0;
  }

  deleteShot(id: number): boolean {
    const db = getDb();
    // shot_sample rows are removed by the FK's ON DELETE CASCADE.
    const result = db
      .prepare("DELETE FROM shot WHERE id = ?")
      .run(id) as { changes: number };
    return result.changes > 0;
  }

  findActive(): Shot | undefined {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM shot WHERE ended_at IS NULL LIMIT 1")
      .get() as unknown as RawShotRow | undefined;
    return row ? toShot(row) : undefined;
  }

  finalizeAllOpen(endedAt: number, stopMode: StopMode): number {
    const db = getDb();
    // Conservative: only ended_at + stop_mode. No measurement columns are
    // invented — yield/snapshot fields keep whatever (if anything) was recorded.
    const result = db
      .prepare("UPDATE shot SET ended_at = ?, stop_mode = ? WHERE ended_at IS NULL")
      .run(endedAt, stopMode) as { changes: number | bigint };
    return Number(result.changes);
  }

  findLast(filter: {
    beanId?: number; grinderId?: number; profileId?: number; basketId?: number; withDose?: boolean;
  }): Shot | undefined {
    const db = getDb();
    const conditions: string[] = [];
    const params: number[] = [];
    if (filter.beanId !== undefined) {
      conditions.push("bean_id = ?");
      params.push(filter.beanId);
    }
    if (filter.grinderId !== undefined) {
      conditions.push("grinder_id = ?");
      params.push(filter.grinderId);
    }
    if (filter.profileId !== undefined) {
      conditions.push("profile_id = ?");
      params.push(filter.profileId);
    }
    if (filter.basketId !== undefined) {
      conditions.push("basket_id = ?");
      params.push(filter.basketId);
    }
    if (conditions.length === 0) return undefined;
    // Not a selector on its own — must not satisfy the guard above.
    if (filter.withDose) conditions.push("dose_g IS NOT NULL");
    // Nur Bezuege: Wartung und Messlaeufe sind keine Vorlage fuer Mahlgrad/Dosis.
    conditions.push("category = 'brew'");

    const row = db
      .prepare(
        `SELECT * FROM shot WHERE ${conditions.join(" AND ")}
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(...params) as unknown as RawShotRow | undefined;
    return row ? toShot(row) : undefined;
  }

  findLastByCoffee(filter: {
    coffeeId: number; grinderId?: number; withDose?: boolean;
  }): Shot | undefined {
    const db = getDb();
    const conditions = ["b.coffee_id = ?", "s.category = 'brew'"];
    const params: number[] = [filter.coffeeId];
    if (filter.grinderId !== undefined) {
      conditions.push("s.grinder_id = ?");
      params.push(filter.grinderId);
    }
    if (filter.withDose) conditions.push("s.dose_g IS NOT NULL");
    const row = db
      .prepare(
        `SELECT s.* FROM shot s
         JOIN bean b ON b.id = s.bean_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY s.started_at DESC LIMIT 1`,
      )
      .get(...params) as unknown as RawShotRow | undefined;
    return row ? toShot(row) : undefined;
  }

  findLastSameRoast(filter: { beanId: number; profileId: number; basketId: number; grinderId: number }): Shot | undefined {
    const row = getDb()
      .prepare(
        `SELECT s.* FROM shot s
           JOIN bean b ON b.id = s.bean_id
           JOIN coffee c ON c.id = b.coffee_id
          WHERE s.profile_id = ? AND s.basket_id = ? AND s.grinder_id = ?
            AND s.category = 'brew'
            AND c.roast_level IS NOT NULL
            AND c.roast_level = (SELECT c2.roast_level FROM bean b2 JOIN coffee c2 ON c2.id = b2.coffee_id WHERE b2.id = ?)
          ORDER BY s.started_at DESC LIMIT 1`,
      )
      .get(filter.profileId, filter.basketId, filter.grinderId, filter.beanId) as unknown as RawShotRow | undefined;
    return row ? toShot(row) : undefined;
  }

  findPreviousSameCoffee(id: number): ShotCompare["previous"] {
    const row = getDb()
      .prepare(
        `SELECT p.id, p.started_at, COALESCE(pr.name, p.profile_name) AS profile_name, p.grind_setting
           FROM shot s
           JOIN bean b ON b.id = s.bean_id
           JOIN shot p ON p.id <> s.id AND p.started_at < s.started_at
                      AND p.ended_at IS NOT NULL AND p.category = 'brew'
           JOIN bean pb ON pb.id = p.bean_id AND pb.coffee_id = b.coffee_id
           LEFT JOIN profile pr ON pr.id = p.profile_id
          WHERE s.id = ?
          ORDER BY p.started_at DESC LIMIT 1`,
      )
      .get(id) as { id: number; started_at: number; profile_name: string | null; grind_setting: number | null } | undefined;
    return row
      ? { id: row.id, startedAt: row.started_at, profileName: row.profile_name, grindSetting: row.grind_setting }
      : null;
  }

  findReferenceSameCoffee(id: number): number | null {
    const row = getDb()
      .prepare(
        `SELECT bb.shot_id
           FROM shot s
           JOIN bean b ON b.id = s.bean_id
           JOIN best_brew bb ON bb.coffee_id = b.coffee_id AND bb.shot_id <> s.id
          WHERE s.id = ?`,
      )
      .get(id) as { shot_id: number } | undefined;
    return row ? row.shot_id : null;
  }

  listNetworkShots(filter: { coffeeId?: number; profileId?: number }): NetShot[] {
    const conds = ["s.category = 'brew'", "s.ended_at IS NOT NULL"];
    const params: number[] = [];
    if (filter.coffeeId !== undefined) { conds.push("b.coffee_id = ?"); params.push(filter.coffeeId); }
    if (filter.profileId !== undefined) { conds.push("s.profile_id = ?"); params.push(filter.profileId); }
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.started_at, s.profile_id, COALESCE(p.name, s.profile_name, '(Profil gelöscht)') AS profile_name,
                s.variant_id, s.basket_id, s.grinder_id, b.coffee_id, c.name AS coffee_name, s.bean_label,
                s.grind_setting, s.grind_note, s.rating, s.acidity, s.bitterness, s.extraction_under, s.extraction_over,
                s.channeling, s.channeling_severity, s.taste_tags,
                CASE WHEN bb.shot_id IS NOT NULL THEN 1 ELSE 0 END AS is_best
           FROM shot s
           LEFT JOIN profile p ON p.id = s.profile_id
           LEFT JOIN bean b ON b.id = s.bean_id
           LEFT JOIN coffee c ON c.id = b.coffee_id
           LEFT JOIN best_brew bb ON bb.shot_id = s.id
          WHERE ${conds.join(" AND ")}
          ORDER BY s.started_at`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      startedAt: r.started_at as number,
      profileId: r.profile_id as number | null,
      profileName: r.profile_name as string,
      variantId: r.variant_id as number | null,
      basketId: r.basket_id as number | null,
      grinderId: r.grinder_id as number | null,
      coffeeId: (r.coffee_id as number | null) ?? null,
      coffeeName: (r.coffee_name as string | null) ?? null,
      beanLabel: r.bean_label as string | null,
      grindSetting: r.grind_setting as number | null,
      grindNote: r.grind_note as NetShot["grindNote"],
      rating: r.rating as number | null,
      acidity: r.acidity as number | null,
      bitterness: r.bitterness as number | null,
      extractionUnder: r.extraction_under === 1,
      extractionOver: r.extraction_over === 1,
      channeling: r.channeling === 1,
      channelingSeverity: r.channeling_severity as NetShot["channelingSeverity"],
      tasteTags: r.taste_tags ? (JSON.parse(r.taste_tags as string) as string[]) : null,
      isBestBrew: r.is_best === 1,
    }));
  }

  listRecentBrew(limit: number): RecentShot[] {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT s.id, s.profile_id,
                CASE WHEN p.name IS NOT NULL THEN p.name
                     WHEN s.profile_name IS NOT NULL THEN s.profile_name || ' (Profil gelöscht)'
                     ELSE '(Profil gelöscht)' END AS profile_name,
                s.shot_size, s.variant_id, s.basket_id,
                s.bean_id, s.bean_label, c.name AS bean_name, c.roaster AS bean_roaster,
                s.grinder_id, g.name AS grinder_name,
                s.grind_setting, s.grinder_rpm, s.dose_g, s.yield_target_g, s.yield_actual_g,
                s.started_at, s.ended_at, s.rating
         FROM shot s
         LEFT JOIN profile p ON p.id = s.profile_id
         LEFT JOIN bean b ON b.id = s.bean_id
         LEFT JOIN coffee c ON c.id = b.coffee_id
         LEFT JOIN grinder g ON g.id = s.grinder_id
         WHERE s.category = 'brew'
         ORDER BY s.started_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as RawRecentShotRow[];
    return rows.map(toRecentShot);
  }
}

// ---------------------------------------------------------------------------
// Internal row → domain mapping
// ---------------------------------------------------------------------------

interface RawShotRow {
  id: number;
  variant_id?: number | null;
  basket_id?: number | null;
  profile_id: number | null; // nullable since the profile_id ON DELETE SET NULL migration
  script_id: number | null; // nullable since the script_id NOT NULL drop (Cut-2 step drives)
  shot_size: string;
  category: string;
  started_at: number;
  ended_at: number | null;
  stop_mode: string | null;
  yield_target_g: number | null;
  yield_actual_g: number | null;
  has_cmd27: number;
  cmd27_value: number | null;
  notes: string | null;
  // Step 8 extensions
  bean_id: number | null;
  bean_label: string | null;
  grinder_id: number | null;
  grind_setting: number | null;
  grinder_rpm: number | null;
  dose_g: number | null;
  tds_percent: number | null;
  rating: number | null;
  acidity: number | null;
  bitterness: number | null;
  extraction_under: number;
  extraction_over: number;
  channeling: number;
  channeling_severity: string | null;
  vs_prev: string | null;
  vs_prev_shot_id: number | null;
  scale_frozen: number;
  scale_lost: number;
  taste_tags: string | null;
  grind_note: string | null;
  brew_def_hash: string | null;
}

interface RawSampleRow {
  id: number;
  shot_id: number;
  elapsed_ms: number;
  pressure_bar: number | null;
  flow_ml_s: number | null;
  flow_meter_ml: number | null;
  temp_bg_c: number | null;
  temp_bb_c: number | null;
  weight_g: number | null;
  pump_pwm: number | null;
  phase: "preinfusion" | "extraction" | "post_brew" | "brewing";
}

interface RawShotStageRow {
  stage_index: number;
  step_kind: "flow" | "pressure" | "power";
  target_flow_gs: number | null;
  target_pressure_bar: number | null;
  target_power: number | null;
  exit_reason: "seconds" | "weightG" | "pressureBar" | "flowGs" | "pressureBelowBar" | "flowAboveGs" | "arrived" | null;
  entered_ms: number;
}

function toShot(row: RawShotRow): Shot {
  return {
    id: row.id,
    profileId: row.profile_id ?? null,
    variantId: row.variant_id ?? null,
    basketId: row.basket_id ?? null,
    scriptId: row.script_id,
    shotSize: row.shot_size as Shot["shotSize"],
    category: row.category as Shot["category"],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    stopMode: (row.stop_mode ?? null) as Shot["stopMode"],
    yieldTargetG: row.yield_target_g,
    yieldActualG: row.yield_actual_g,
    hasCmd27: row.has_cmd27 === 1,
    cmd27Value: row.cmd27_value,
    scaleFrozen: row.scale_frozen === 1,
    scaleLost: row.scale_lost === 1,
    notes: row.notes,
    // Step 8 extensions
    beanId: row.bean_id ?? null,
    beanLabel: row.bean_label ?? null,
    grinderId: row.grinder_id ?? null,
    grindSetting: row.grind_setting ?? null,
    grinderRpm: row.grinder_rpm ?? null,
    doseG: row.dose_g ?? null,
    tdsPercent: row.tds_percent ?? null,
    rating: row.rating ?? null,
    acidity: row.acidity ?? null,
    bitterness: row.bitterness ?? null,
    extractionUnder: row.extraction_under === 1,
    extractionOver: row.extraction_over === 1,
    channeling: row.channeling === 1,
    channelingSeverity: (row.channeling_severity as ChannelingSeverity | null) ?? null,
    vsPrev: (row.vs_prev as VsPrev | null) ?? null,
    vsPrevShotId: row.vs_prev_shot_id ?? null,
    tasteTags: parseTasteTags(row.taste_tags),
    grindNote: (row.grind_note ?? null) as GrindNote | null,
    brewDefHash: row.brew_def_hash ?? null,
  };
}

interface RawRecentShotRow {
  bean_label: string | null;
  id: number;
  variant_id: number | null;
  basket_id: number | null;
  profile_id: number | null;
  profile_name: string;
  shot_size: string;
  bean_id: number | null;
  bean_name: string | null;
  bean_roaster: string | null;
  grinder_id: number | null;
  grinder_name: string | null;
  grind_setting: number | null;
  grinder_rpm: number | null;
  dose_g: number | null;
  yield_target_g: number | null;
  yield_actual_g: number | null;
  started_at: number;
  ended_at: number | null;
  rating: number | null;
}

interface RawShotListRow {
  bean_label: string | null;
  id: number;
  variant_id: number | null;
  basket_id: number | null;
  profile_id: number | null;
  profile_name: string;
  shot_size: string;
  category: string;
  started_at: number;
  ended_at: number | null;
  yield_target_g: number | null;
  yield_actual_g: number | null;
  stop_mode: string | null;
  rating: number | null;
  acidity: number | null;
  bitterness: number | null;
  extraction_under: number;
  extraction_over: number;
  channeling: number;
  channeling_severity: string | null;
  vs_prev: string | null;
  vs_prev_shot_id: number | null;
  taste_tags: string | null;
  grind_note: string | null;
  notes: string | null;
  bean_id: number | null;
  bean_name: string | null;
  bean_roaster: string | null;
  bean_brew_type: string | null;
  grinder_id: number | null;
  grinder_name: string | null;
  grind_setting: number | null;
  grinder_rpm: number | null;
  dose_g: number | null;
  tds_percent: number | null;
  profile_set_temp_c: number | null;
  is_best_brew: number;
}

function toShotListItem(row: RawShotListRow): ShotListItem {
  return {
    id: row.id,
    profileId: row.profile_id,
    variantId: row.variant_id,
    basketId: row.basket_id,
    profileName: row.profile_name,
    shotSize: row.shot_size as ShotListItem["shotSize"],
    category: row.category as ShotListItem["category"],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    yieldTargetG: row.yield_target_g,
    yieldActualG: row.yield_actual_g,
    stopMode: (row.stop_mode ?? null) as StopMode | null,
    rating: row.rating ?? null,
    acidity: row.acidity ?? null,
    bitterness: row.bitterness ?? null,
    extractionUnder: row.extraction_under === 1,
    extractionOver: row.extraction_over === 1,
    channeling: row.channeling === 1,
    channelingSeverity: (row.channeling_severity as ChannelingSeverity | null) ?? null,
    vsPrev: (row.vs_prev as VsPrev | null) ?? null,
    vsPrevShotId: row.vs_prev_shot_id ?? null,
    tasteTags: parseTasteTags(row.taste_tags),
    grindNote: (row.grind_note ?? null) as GrindNote | null,
    notes: row.notes,
    beanId: row.bean_id,
    beanLabel: row.bean_label ?? null,
    beanName: row.bean_name,
    beanRoaster: row.bean_roaster,
    beanBrewType: (row.bean_brew_type ?? null) as BrewType | null,
    grinderId: row.grinder_id,
    grinderName: row.grinder_name,
    grindSetting: row.grind_setting,
    grinderRpm: row.grinder_rpm,
    doseG: row.dose_g,
    tdsPercent: row.tds_percent,
    profileSetTempC: row.profile_set_temp_c,
    isBestBrew: row.is_best_brew === 1,
  };
}

function toRecentShot(row: RawRecentShotRow): RecentShot {
  return {
    id: row.id,
    profileId: row.profile_id,
    variantId: row.variant_id,
    basketId: row.basket_id,
    profileName: row.profile_name,
    shotSize: row.shot_size as RecentShot["shotSize"],
    beanId: row.bean_id,
    beanLabel: row.bean_label ?? null,
    beanName: row.bean_name,
    beanRoaster: row.bean_roaster,
    grinderId: row.grinder_id,
    grinderName: row.grinder_name,
    grindSetting: row.grind_setting,
    grinderRpm: row.grinder_rpm,
    doseG: row.dose_g,
    yieldTargetG: row.yield_target_g,
    yieldActualG: row.yield_actual_g,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rating: row.rating ?? null,
  };
}

function toSample(row: RawSampleRow): Sample {
  return {
    id: row.id,
    shotId: row.shot_id,
    elapsedMs: row.elapsed_ms,
    pressureBar: row.pressure_bar,
    flowMlS: row.flow_ml_s,
    flowMeterMl: row.flow_meter_ml,
    tempBgC: row.temp_bg_c,
    tempBbC: row.temp_bb_c,
    weightG: row.weight_g,
    pumpPwm: row.pump_pwm,
    phase: row.phase,
  };
}
