const jwt = require('jsonwebtoken');

// Helper to extract token from cookies without extra libraries
function getTokenFromRequest(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  const tokenCookie = cookies.find((c) => c.startsWith('token='));
  if (!tokenCookie) return null;

  const token = tokenCookie.split('=')[1];
  return decodeURIComponent(token);
}

function authMiddleware(req, res, next) {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      return res.status(401).json({ message: 'No autorizado. Token no proporcionado.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: decoded.id,
      email: decoded.email,
      fullName: decoded.fullName,
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Token inválido o expirado.' });
  }
}

module.exports = authMiddleware;

