require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { handleDisposition } = require('./handlers/disposition');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/webhook', limiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'PowerDialer → Apollo sync is running',
    timestamp: new Date().toISOString()
  });
});

// Main webhook endpoint for PowerDialer
app.post('/webhook/powerdialer', async (req, res) => {
  const startTime = Date.now();
  const { contact_email, disposition, contact_name, notes, timestamp } = req.body;

  logger.info('📞 Received webhook', {
    contact_email,
    disposition,
    contact_name,
    timestamp
  });

  // Validate required fields
  if (!contact_email || !disposition) {
    logger.error('❌ Missing required fields', { body: req.body });
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: contact_email and disposition are required'
    });
  }

  try {
    // Handle the disposition and update Apollo
    const result = await handleDisposition({
      contactEmail: contact_email,
      disposition: disposition,
      contactName: contact_name,
      notes: notes,
      timestamp: timestamp
    });

    const duration = Date.now() - startTime;
    logger.info(`✅ Successfully processed in ${duration}ms`, {
      contact_email,
      disposition,
      action: result.action
    });

    res.json({
      success: true,
      message: result.message,
      contact: contact_email,
      disposition: disposition,
      action: result.action,
      processingTime: `${duration}ms`
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('❌ Error processing webhook', {
      error: error.message,
      contact_email,
      disposition,
      stack: error.stack,
      duration: `${duration}ms`
    });

    res.status(500).json({
      success: false,
      error: error.message,
      contact: contact_email,
      suggestion: error.suggestion || 'Check server logs for details'
    });
  }
});

// Test endpoint
app.post('/webhook/test', async (req, res) => {
  logger.info('🧪 Test webhook called', req.body);
  res.json({
    success: true,
    message: 'Test webhook received successfully',
    receivedData: req.body
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Webhook server running on port ${PORT}`);
  logger.info(`📡 Webhook URL: http://localhost:${PORT}/webhook/powerdialer`);
  logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
  logger.info(`🔑 Apollo Email Account ID: ${process.env.APOLLO_EMAIL_ACCOUNT_ID}`);
});

module.exports = app;
