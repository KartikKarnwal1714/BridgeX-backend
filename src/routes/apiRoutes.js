const express = require('express');
const apiController = require('../controllers/apiController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validation');
const { createApiSchema, updateApiSchema } = require('../schemas/apiSchemas');

const router = express.Router();

router.use(authenticate);

router.get('/', apiController.list); // all authenticated roles can view APIs
router.get('/:id', apiController.getOne);
router.post('/', authorize('SUPER_ADMIN'), validate(createApiSchema), apiController.create);
router.put('/:id', authorize('SUPER_ADMIN'), validate(updateApiSchema), apiController.update);
router.delete('/:id', authorize('SUPER_ADMIN'), apiController.remove);

module.exports = router;
