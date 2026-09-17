const { errorResponse } = require("../utils/apiResponse");

function requireAuth(req, res, next) {
  if (!req.session || !req.session.admin) {
    return errorResponse(res, "Authentication required", "UNAUTHORIZED", 401);
  }

  return next();
}

module.exports = {
  requireAuth,
};
