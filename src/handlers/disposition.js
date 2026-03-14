const { findContactByEmail, addToSequence, removeFromSequences } = require('./apollo');
const { DISPOSITION_MAP } = require('../config/apollo');
const logger = require('../utils/logger');

async function handleDisposition({ contactEmail, disposition, contactName, notes, timestamp }) {
  logger.info(`Processing disposition: ${disposition} for ${contactEmail}`);

  // Step 1: Find contact in Apollo
  const contact = await findContactByEmail(contactEmail);

  if (!contact) {
    const error = new Error('Contact not found in Apollo');
    error.suggestion = 'Make sure this contact exists in Apollo.io before making calls';
    throw error;
  }

  logger.info(`Found contact in Apollo`, {
    contactId: contact.id,
    name: `${contact.first_name} ${contact.last_name}`
  });

  // Step 2: Get action mapping for this disposition
  const mapping = DISPOSITION_MAP[disposition];

  if (!mapping) {
    logger.warn(`No mapping found for disposition: ${disposition}`, {
      availableDispositions: Object.keys(DISPOSITION_MAP)
    });
    return {
      action: 'none',
      message: 'Disposition logged, but no action configured for this disposition type'
    };
  }

  // Step 3: Execute the appropriate action
  let result;

  if (mapping.action === 'add') {
    logger.info(`Adding contact to sequence`, {
      sequenceId: mapping.sequenceId,
      sequenceName: mapping.sequenceName
    });

    result = await addToSequence(contact.id, mapping.sequenceId);

    return {
      action: 'added_to_sequence',
      message: `Contact added to ${mapping.sequenceName} sequence`,
      sequenceId: mapping.sequenceId,
      sequenceName: mapping.sequenceName
    };

  } else if (mapping.action === 'remove') {
    logger.info(`Removing contact from all sequences`);

    result = await removeFromSequences(contact.id, disposition);

    return {
      action: 'removed_from_sequences',
      message: 'Contact removed from all active sequences',
      reason: disposition
    };

  } else {
    return {
      action: 'none',
      message: 'Disposition logged, no sequence changes made'
    };
  }
}

module.exports = {
  handleDisposition
};
