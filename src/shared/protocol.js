"use strict";

const COMMANDS = Object.freeze({
  HOME: "home",
  PATIENT: "patient",
  DISPLAY_CONFIG: "display_config",
  APPOINTMENT_QR: "appointment_qr",
  TREATMENT_GIF: "treatment_gif",
  TREATMENT_PLAN: "treatment_plan",
  PLAN_NAVIGATE: "plan_navigate",
  GAME: "game",
  IMAGE: "image",
  GIF: "gif",
  VIDEO: "video",
  PDF: "pdf",
  BLACK: "black",
  HIDE: "hide",
  TRANSFORM: "transform",
  RESET_VIEW: "reset_view",
  PING: "ping"
});

const CLINICAL_MESSAGES = Object.freeze({
  CLIENT_HELLO: "client_hello",
  DISPLAY_READY: "display_ready",
  ASSISTANT_READY: "assistant_ready",
  ASSISTANT_CONTEXT: "assistant_patient_context",
  ASSISTANT_STAGE: "assistant_stage_updated",
  ASSISTANT_SESSION: "assistant_session",
  ASSISTANT_PLAN_CLOSED: "assistant_plan_closed"
});

module.exports = {COMMANDS,CLINICAL_MESSAGES};
