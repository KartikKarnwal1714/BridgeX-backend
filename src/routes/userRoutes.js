const express = require('express');
const userController = require('../controllers/userController');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validation');
const { createUserSchema, updateUserSchema } = require('../schemas/userSchemas');

const router = express.Router();

router.use(authenticate);

router.get('/', authorize('SUPER_ADMIN', 'SUPPORT'), userController.list);
router.get('/:id', authorize('SUPER_ADMIN', 'SUPPORT'), userController.getOne);
router.post('/', authorize('SUPER_ADMIN'), validate(createUserSchema), userController.create);
router.put('/:id', authorize('SUPER_ADMIN'), validate(updateUserSchema), userController.update);
router.delete('/:id', authorize('SUPER_ADMIN'), userController.remove);

module.exports = router;
