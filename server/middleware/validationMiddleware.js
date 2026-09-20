const { validationResult } = require("express-validator");
const { errorResponse } = require("../utils/apiResponse");

function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    const fields = [...new Set(result.array().map((err) => err.path || err.param))];
    return errorResponse(res, `Validation failed: invalid ${fields.join(", ")}`, "VALIDATION_ERROR", 422);
  }

  return next();
}

module.exports = {
  validateRequest,
};
