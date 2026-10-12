const express = require('express');
const dashboardController = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/stats', dashboardController.stats);
router.get('/traffic', dashboardController.traffic);
router.get('/protocol-distribution', dashboardController.protocolDistribution);
router.get('/top-apis', dashboardController.topApis);
router.get('/system-status', dashboardController.systemStatus);

module.exports = router;
