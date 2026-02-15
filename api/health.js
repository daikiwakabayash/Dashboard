export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    ok: true,
    node: process.version,
    env: {
      hasAccessToken: !!process.env.SQUARE_ACCESS_TOKEN,
      hasLocationId: !!process.env.SQUARE_LOCATION_ID,
      hasEnvironment: !!process.env.SQUARE_ENVIRONMENT,
    },
  });
}
