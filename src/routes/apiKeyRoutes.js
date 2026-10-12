const express = require('express');
const apiKeyController = require('../controllers/apiKeyController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validation');
const { createApiKeySchema, updateKeyGatewaySchema } = require('../schemas/apiKeySchemas');

const router = express.Router();

router.use(authenticate);

router.get('/', apiKeyController.list);
router.post('/', authorize('SUPER_ADMIN', 'DEVELOPER'), validate(createApiKeySchema), apiKeyController.create);
router.patch('/:id/revoke', authorize('SUPER_ADMIN', 'DEVELOPER'), apiKeyController.revoke);
// Rate limit, expiry and which APIs a key may call. Administrators only: granting access to an
// upstream is a platform-level decision, not something a key's owner can do for themselves.
router.patch('/:id/gateway', authorize('SUPER_ADMIN'), validate(updateKeyGatewaySchema), apiKeyController.updateGateway);
router.delete('/:id', authorize('SUPER_ADMIN'), apiKeyController.remove);

module.exports = router;
