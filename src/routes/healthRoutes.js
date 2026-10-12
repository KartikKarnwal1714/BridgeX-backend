const express = require('express');
const healthController = require('../controllers/healthController');

const router = express.Router();

router.get('/', healthController.health);
router.get('/live', healthController.live);
router.get('/ready', healthController.ready);

module.exports = router;
