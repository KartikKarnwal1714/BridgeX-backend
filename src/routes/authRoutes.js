const express = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validation');
const { registerSchema, loginSchema } = require('../schemas/authSchemas');

const router = express.Router();

router.post('/register', validate(registerSchema), authController.register);
router.post('/login', validate(loginSchema), authController.login);
router.get('/me', authenticate, authController.me);

module.exports = router;
