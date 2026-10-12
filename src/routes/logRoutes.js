const express = require('express');
const logController = require('../controllers/logController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);
// Request logs describe all traffic, so VIEWER accounts cannot read them.
router.use(authorize('SUPER_ADMIN', 'DEVELOPER', 'SUPPORT'));

router.get('/', logController.list);
router.get('/:id', logController.getOne);

module.exports = router;
