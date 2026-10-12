const express = require('express');
const settingsController = require('../controllers/settingsController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validation');
const { updateSettingsSchema } = require('../schemas/settingsSchemas');

const router = express.Router();

router.use(authenticate);

router.get('/', settingsController.get);
router.put('/', authorize('SUPER_ADMIN'), validate(updateSettingsSchema), settingsController.update);

module.exports = router;
