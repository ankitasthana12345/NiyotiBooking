const { errorResponse } = require("../utils/apiResponse");

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.admin || req.session.admin.role !== "ADMIN") {
    return errorResponse(res, "Admin access required", "FORBIDDEN", 403);
  }

  return next();
}

module.exports = {
  requireAdmin,
};
