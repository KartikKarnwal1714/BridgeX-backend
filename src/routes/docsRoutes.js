const express = require('express');
const docsController = require('../controllers/docsController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/endpoints', docsController.endpoints);

module.exports = router;
