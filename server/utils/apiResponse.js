function successResponse(res, message, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

function errorResponse(res, message, errorCode = "REQUEST_FAILED", statusCode = 400) {
  return res.status(statusCode).json({
    success: false,
    message,
    errorCode,
  });
}

module.exports = {
  successResponse,
  errorResponse,
};
