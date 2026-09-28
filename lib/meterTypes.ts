/** Historical journal meter schema; new readings use monitorTypes. */
/** One window of the meter: `utilization` in [0, 1], `resets_at` ISO. */
export interface MeterWindow {
  utilization: number;
  resets_at: string;
}

/** A reading of the meter — either window may be absent (an older CLI, a
 * plan without the weekly window). */
export interface MeterReading {
  five_hour?: MeterWindow;
  seven_day?: MeterWindow;
}

/** A run's bracket: the meter at its first and last API response. */
export interface RunMeter {
  before: MeterReading;
  after: MeterReading;
}
