const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');
const logger = require('./logger');

// Track recently used descriptions to avoid repetition
const recentDescriptions = [];
const MAX_RECENT = 20;

/**
 * Initialize Gemini AI model
 */
function initGemini() {
  if (!config.geminiApiKey || config.geminiApiKey === 'your_gemini_api_key_here') {
    logger.warn('Gemini API key not configured. Using fallback task descriptions.');
    return null;
  }

  const genAI = new GoogleGenerativeAI(config.geminiApiKey);
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

let geminiModel = null;

/**
 * Get the initialized Gemini model (lazy initialization)
 */
function getModel() {
  if (!geminiModel) {
    geminiModel = initGemini();
  }
  return geminiModel;
}

/**
 * Generate a realistic task description using Gemini AI
 * @param {'morning' | 'evening'} shift - The shift type
 * @returns {Promise<{description: string, remarks: string, maxHours: string}>}
 */
async function generateTask(shift) {
  const model = getModel();

  if (model) {
    try {
      return await generateWithAI(model, shift);
    } catch (error) {
      logger.error('AI generation failed, using fallback:', error.message);
      return generateFallback(shift);
    }
  }

  return generateFallback(shift);
}

/**
 * Generate task description using Gemini AI
 */
async function generateWithAI(model, shift) {
  const today = new Date();
  const dayOfWeek = today.toLocaleDateString('en-IN', { weekday: 'long' });
  const dateStr = today.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const recentList = recentDescriptions.length > 0
    ? `\n\nAVOID these recently used descriptions (be different):\n${recentDescriptions.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
    : '';

  const prompt = `You are generating a daily work task entry for a Programmer working at Himachal Pradesh University (HPU), Shimla. 
The employee works in IT/computer department handling technical and procurement-related work.

Generate a realistic, professional daily task description for the ${shift === 'morning' ? 'MORNING' : 'EVENING'} shift on ${dayOfWeek}, ${dateStr}.

The task should be ONE of these categories (pick randomly, vary each time):
1. GeM (Government e-Marketplace) related - bid opening, bid evaluation, product listing review, vendor comparison on GeM portal
2. Tender/Procurement - tender document preparation, tender evaluation, comparative statement preparation, purchase committee work
3. Vendor bill processing - bill verification, invoice processing, payment file forwarding, expenditure tracking
4. e-Office / NIC coordination - e-office file processing, digital file management, NIC helpdesk coordination
5. Software/technical work - university website updates, portal maintenance, database management, application testing
6. Hardware/IT inventory - hardware audit, IT equipment inventory update, AMC tracking, asset register maintenance
7. Meeting/coordination - attending procurement committee meeting, IT review meeting, departmental coordination meeting
8. Report/documentation - preparing MIS reports, compliance documentation, IT infrastructure report, quarterly review documents
9. GFR compliance - following GFR rules for procurement, financial rule compliance documentation
10. Network/infrastructure - LAN troubleshooting, server monitoring, internet connectivity issue resolution

Requirements:
- Description should be 1-2 sentences, professional government office language
- Keep it specific with realistic details (mention specific systems, file numbers, portal names)
- Make it sound like genuine daily work, not AI-generated
- ${shift === 'morning' ? 'Morning tasks are typically more routine/administrative' : 'Evening tasks are typically follow-up/completion oriented'}
${recentList}

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{"description": "Your task description here", "remarks": "Brief remark about the task status or outcome"}`;

  const result = await model.generateContent(prompt);
  const responseText = result.response.text().trim();

  // Parse the JSON response
  let parsed;
  try {
    // Try to extract JSON if wrapped in code blocks
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
  } catch (parseError) {
    logger.warn('Failed to parse AI response as JSON, using raw text');
    parsed = {
      description: responseText.substring(0, 200),
      remarks: 'Task completed as per schedule',
    };
  }

  // Track for deduplication
  recentDescriptions.push(parsed.description);
  if (recentDescriptions.length > MAX_RECENT) {
    recentDescriptions.shift();
  }

  const maxHours = config.shiftHours[shift] || (shift === 'morning' ? '4' : '3');

  logger.info(`AI generated task: "${parsed.description.substring(0, 60)}..."`);

  return {
    description: parsed.description,
    remarks: parsed.remarks || 'Task completed successfully',
    maxHours,
  };
}

/**
 * Fallback task descriptions when AI is not available
 */
const fallbackTasks = {
  morning: [
    {
      description: 'Processed GeM bid opening for IT equipment procurement. Evaluated vendor bids and prepared comparative statement for purchase committee review.',
      remarks: 'Bid evaluation completed for reference file',
    },
    {
      description: 'Worked on e-Office file processing for pending purchase orders. Forwarded vendor invoices to accounts section for payment release.',
      remarks: 'Files forwarded to accounts section',
    },
    {
      description: 'Updated university IT asset register with recently procured hardware items. Verified AMC status of existing equipment and prepared renewal list.',
      remarks: 'Asset register updated',
    },
    {
      description: 'Prepared tender evaluation report for network equipment procurement under GFR guidelines. Reviewed vendor compliance documents and technical specifications.',
      remarks: 'Evaluation report submitted',
    },
    {
      description: 'Coordinated with NIC team for university portal maintenance. Tested application modules after recent updates and documented issues found.',
      remarks: 'Portal maintenance coordination done',
    },
    {
      description: 'Processed vendor bill verification for IT consumables purchased through GeM portal. Cross-checked delivery challan with purchase order details.',
      remarks: 'Bills verified and forwarded',
    },
    {
      description: 'Attended procurement committee meeting regarding upcoming IT infrastructure upgrades. Prepared requirement specifications for server room equipment.',
      remarks: 'Meeting minutes documented',
    },
    {
      description: 'Worked on quarterly MIS report preparation for IT department. Compiled data on procurement activities and expenditure tracking for the current quarter.',
      remarks: 'MIS report drafted',
    },
    {
      description: 'Managed e-office digital file movement for pending IT procurement cases. Updated file noting and forwarded to competent authority for approval.',
      remarks: 'Files processed in e-office',
    },
    {
      description: 'Reviewed GeM product listings for upcoming desktop computer procurement. Compared vendor ratings, specifications, and delivery timelines for best value.',
      remarks: 'Product comparison completed',
    },
  ],
  evening: [
    {
      description: 'Followed up on pending vendor payments and updated payment tracking register. Verified invoice status in PFMS portal for released payments.',
      remarks: 'Payment tracking updated',
    },
    {
      description: 'Completed tender document review for upcoming printer procurement. Finalized technical specifications and prepared draft NIT for approval.',
      remarks: 'Tender draft prepared',
    },
    {
      description: 'Resolved network connectivity issues in administrative block. Configured LAN settings and coordinated with ISP for bandwidth optimization.',
      remarks: 'Network issue resolved',
    },
    {
      description: 'Updated university website content as per departmental requests. Uploaded notification documents and verified download links for correctness.',
      remarks: 'Website updated successfully',
    },
    {
      description: 'Prepared IT infrastructure status report for departmental review meeting. Compiled server uptime data, network performance metrics, and pending issues.',
      remarks: 'Status report compiled',
    },
    {
      description: 'Completed GFR compliance documentation for recent IT procurement activities. Verified adherence to procurement rules and updated compliance register.',
      remarks: 'Compliance documentation completed',
    },
    {
      description: 'Followed up on GeM order delivery status for IT peripherals. Coordinated with vendor regarding delayed shipment and updated delivery timeline.',
      remarks: 'Vendor coordination done',
    },
    {
      description: 'Worked on database backup verification and server monitoring tasks. Checked backup logs and verified data integrity for critical university databases.',
      remarks: 'Backup verification completed',
    },
    {
      description: 'Processed pending e-office files related to IT equipment condemnation. Prepared write-off proposal with asset details and depreciation calculations.',
      remarks: 'Condemnation files processed',
    },
    {
      description: 'Attended departmental coordination meeting for IT support requirements. Discussed upcoming exam portal readiness and allocated support tasks.',
      remarks: 'Coordination meeting attended',
    },
  ],
};

/**
 * Generate a fallback task description (no AI)
 */
function generateFallback(shift) {
  const tasks = fallbackTasks[shift] || fallbackTasks.morning;

  // Pick a random task, trying to avoid recent ones
  let attempts = 0;
  let task;
  do {
    task = tasks[Math.floor(Math.random() * tasks.length)];
    attempts++;
  } while (
    recentDescriptions.includes(task.description) &&
    attempts < tasks.length
  );

  // Track for deduplication
  recentDescriptions.push(task.description);
  if (recentDescriptions.length > MAX_RECENT) {
    recentDescriptions.shift();
  }

  const maxHours = config.shiftHours[shift] || (shift === 'morning' ? '4' : '3');

  logger.info(`Fallback task selected: "${task.description.substring(0, 60)}..."`);

  return {
    description: task.description,
    remarks: task.remarks,
    maxHours,
  };
}

module.exports = { generateTask, getModel, initGemini };
