export const apiErrorCodes = {
  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    message: "Validation failed"
  },
  LARK_AGENT_NOT_CONFIGURED: {
    code: "LARK_AGENT_NOT_CONFIGURED",
    message: "Lark Agent is not configured"
  },
  LARK_AGENT_UNAVAILABLE: {
    code: "LARK_AGENT_UNAVAILABLE",
    message: "Lark Agent is temporarily unavailable"
  },
  LARK_AGENT_UPSTREAM_FAILED: {
    code: "LARK_AGENT_UPSTREAM_FAILED",
    message: "Lark Agent request failed"
  }
} as const;
