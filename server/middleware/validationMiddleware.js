const { validationResult } = require("express-validator");
const { errorResponse } = require("../utils/apiResponse");

function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return errorResponse(res, "Validation failed", "VALIDATION_ERROR", 422);
  }

  return next();
}

module.exports = {
  validateRequest,
};
