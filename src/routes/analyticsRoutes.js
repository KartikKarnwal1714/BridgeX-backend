const express = require('express');
const analyticsController = require('../controllers/analyticsController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/cards', analyticsController.cards);
router.get('/traffic', analyticsController.traffic);
router.get('/top-endpoints', analyticsController.topEndpoints);

// Per-API and per-key gateway usage reveals who calls what, so it follows the Logs access rule.
router.get('/gateway', authorize('SUPER_ADMIN', 'DEVELOPER', 'SUPPORT'), analyticsController.gateway);

module.exports = router;
