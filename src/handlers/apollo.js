const axios = require('axios');
const logger = require('../utils/logger');

const APOLLO_API_BASE = 'https://api.apollo.io/v1';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': process.env.APOLLO_API_KEY
  };
}

async function findContactByEmail(email) {
  try {
    const response = await axios.post(
      `${APOLLO_API_BASE}/contacts/search`,
      { q_keywords: email, per_page: 1 },
      { headers: getHeaders() }
    );
    const contacts = response.data.contacts || [];
    return contacts.find(c => c.email === email) || null;
  } catch (error) {
    logger.error('Failed to find contact in Apollo', { email, error: error.message });
    throw error;
  }
}

async function addToSequence(contactId, sequenceId) {
  try {
    const response = await axios.post(
      `${APOLLO_API_BASE}/emailer_campaigns/${sequenceId}/add_contact_ids`,
      {
        contact_ids: [contactId],
        emailer_campaign_id: sequenceId,
        send_email_from_email_account_id: process.env.APOLLO_EMAIL_ACCOUNT_ID
      },
      { headers: getHeaders() }
    );
    return response.data;
  } catch (error) {
    logger.error('Failed to add contact to sequence', { contactId, sequenceId, error: error.message });
    throw error;
  }
}

async function removeFromSequences(contactId, reason) {
  try {
    const response = await axios.post(
      `${APOLLO_API_BASE}/emailer_campaigns/remove_or_stop_contact_ids`,
      { contact_ids: [contactId] },
      { headers: getHeaders() }
    );
    return response.data;
  } catch (error) {
    logger.error('Failed to remove contact from sequences', { contactId, error: error.message });
    throw error;
  }
}

module.exports = {
  findContactByEmail,
  addToSequence,
  removeFromSequences
};
