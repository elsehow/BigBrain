import { telemetryConfig } from './telemetryConfig';

/** Confirmed BigBrain US project 619325, API survey created for #952.
 * Release requirement: this project's anonymize_ips setting must remain true.
 * GeoIP suppression alone does not prevent transport IP storage. Reverify
 * stored-event IP absence whenever changing the destination project.
 * Deliberately independent of analytics overrides and consent. No admin keys. */
export const feedbackConfig = {
  ...telemetryConfig,
  surveyId: '01a0d95f-185b-0000-c84e-7c408d388d77',
  questionId: '0d441200-c699-4b39-89e0-1b422647c158',
};
