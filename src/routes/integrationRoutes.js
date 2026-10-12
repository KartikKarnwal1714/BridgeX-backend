const express = require('express');
const integrationController = require('../controllers/integrationController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validation');
const { createIntegrationSchema, updateIntegrationSchema } = require('../schemas/integrationSchemas');

const router = express.Router();

router.use(authenticate);

router.get('/', authorize('SUPER_ADMIN', 'DEVELOPER', 'SUPPORT'), integrationController.list);
router.get('/:id', authorize('SUPER_ADMIN', 'DEVELOPER', 'SUPPORT'), integrationController.getOne);
router.post(
  '/',
  authorize('SUPER_ADMIN', 'DEVELOPER'),
  validate(createIntegrationSchema),
  integrationController.create
);
router.put(
  '/:id',
  authorize('SUPER_ADMIN'),
  validate(updateIntegrationSchema),
  integrationController.update
);
router.delete('/:id', authorize('SUPER_ADMIN'), integrationController.remove);

module.exports = router;
