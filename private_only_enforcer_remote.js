/**
 * Private-Only Enforcer — Remote Logic
 *
 * This file contains generic logic for a "private-only" negative keyword
 * policy. It is designed to be loaded by a tiny Google Ads Script stub
 * using UrlFetchApp + eval(), so that the real behavior can be maintained
 * in version control without editing the Ads UI script.
 *
 * No account IDs, developer tokens, or brand identifiers live in this file.
 * It operates only on the current account's data via AdsApp.
 *
 * Behavior (high-level):
 * - Ensures a label ENFORCE_PRIVATE_TERM exists.
 * - Scans YESTERDAY's search terms for campaigns with that label.
 * - Applies simple intent rules:
 *   - keepTokens: high-end signals (e.g., "private", "vip", "luxury").
 *   - suspiciousTokens: terms that typically indicate group/low-end intent
 *     (e.g., "excursion", "group tour", "bus tour").
 * - For any search term that:
 *   - does NOT contain any keepTokens,
 *   - DOES contain at least one suspiciousToken, and
 *   - is not already an EXACT negative at campaign level,
 *   adds an EXACT negative keyword at the campaign level.
 * - Ignores "uncertain" terms so they can be reviewed separately.
 * - Prevents duplicates and caps new negatives per run.
 * - Logs a summary for review.
 *
 * NOTE:
 * - keepTokens / suspiciousTokens are intentionally generic and contain no
 *   client-specific information.
 */

function runPrivateOnlyEnforcer() {
  var labelName = "ENFORCE_PRIVATE_TERM";
  var maxNewNegativesPerRun = 5000;

  // Intent rules (generic, non-identifying)
  var keepTokens = [
    "private",
    "vip",
    "luxury",
    "bespoke",
    "exclusive"
  ];

  var suspiciousTokens = [
    "excursion",
    "excursions",
    "group tour",
    "group tours",
    "bus tour",
    "bus tours",
    "coach tour",
    "coach tours",
    "hop on hop off",
    "cheap"
  ];

  // Optional allowlist for branded terms (left empty by default).
  var brandAllowlist = [];

  Logger.log("Private-Only Enforcer (remote) starting (label: " + labelName + ")");

  var label = getOrCreateLabel_(labelName);

  var campaigns = getLabeledCampaigns_(labelName);
  if (campaigns.length === 0) {
    Logger.log("No ENABLED campaigns found with label " + labelName + ". Nothing to do.");
    return;
  }

  var campaignIdStrings = campaigns.map(function(c) { return c.getId(); });
  Logger.log("Found " + campaignIdStrings.length + " ENABLED labeled campaigns.");

  var existingNegatives = buildExistingExactNegativesMap_(campaigns);
  var newNegativesCount = 0;

  // Collect YESTERDAY's search terms for labeled campaigns with at least one click.
  var awql = [
    "SELECT CampaignId, CampaignName, Query, Impressions, Clicks, Conversions, Cost",
    "FROM SEARCH_QUERY_PERFORMANCE_REPORT",
    "WHERE CampaignId IN [" + campaignIdStrings.join(",") + "]",
    "  AND CampaignStatus = ENABLED",
    "  AND Clicks >= 1",
    "  AND Date DURING YESTERDAY"
  ].join(" ");

  Logger.log("Running search query report AWQL: " + awql);
  var report = AdsApp.report(awql);
  var rows = report.rows();

  var perCampaignCounts = {};

  while (rows.hasNext() && newNegativesCount < maxNewNegativesPerRun) {
    var row = rows.next();
    var campaignId = parseInt(row["CampaignId"], 10);
    var campaignName = row["CampaignName"];
    var query = row["Query"] || "";

    var intent = classifyIntent_(query, keepTokens, suspiciousTokens, brandAllowlist);

    if (!perCampaignCounts[campaignId]) {
      perCampaignCounts[campaignId] = {
        name: campaignName,
        totalTerms: 0,
        keep: 0,
        blockCandidate: 0,
        uncertain: 0,
        newNegatives: 0
      };
    }
    perCampaignCounts[campaignId].totalTerms++;

    if (intent.intentClass === "keep") {
      perCampaignCounts[campaignId].keep++;
      continue;
    }

    if (intent.intentClass === "uncertain") {
      perCampaignCounts[campaignId].uncertain++;
      continue;
    }

    // At this point, intentClass === "block_candidate".
    perCampaignCounts[campaignId].blockCandidate++;

    var termKey = query.toLowerCase();
    var existingForCampaign = existingNegatives[campaignId] || {};
    if (existingForCampaign[termKey]) {
      // Already an EXACT negative, skip.
      continue;
    }

    if (newNegativesCount >= maxNewNegativesPerRun) {
      break;
    }

    var campaign = getCampaignById_(campaigns, campaignId);
    if (!campaign) {
      continue;
    }

    // Add an EXACT negative at campaign level.
    campaign.createNegativeKeyword("[" + query + "]");
    newNegativesCount++;
    perCampaignCounts[campaignId].newNegatives++;

    // Track in-memory so we don't duplicate within this run.
    existingForCampaign[termKey] = true;
    existingNegatives[campaignId] = existingForCampaign;
  }

  // Summary logging.
  Logger.log("Private-Only Enforcer run summary (remote logic):");
  Logger.log("Total labeled campaigns: " + campaigns.length);
  Logger.log("Total new negatives added: " + newNegativesCount + " (cap: " + maxNewNegativesPerRun + ")");

  for (var cid in perCampaignCounts) {
    if (!perCampaignCounts.hasOwnProperty(cid)) continue;
    var stats = perCampaignCounts[cid];
    Logger.log(
      "Campaign " + cid + " — " + stats.name +
      " | terms: " + stats.totalTerms +
      " | keep: " + stats.keep +
      " | block_candidate: " + stats.blockCandidate +
      " | uncertain: " + stats.uncertain +
      " | new negatives: " + stats.newNegatives
    );
  }

  if (newNegativesCount >= maxNewNegativesPerRun) {
    Logger.log("Hit maxNewNegativesPerRun (" + maxNewNegativesPerRun + "); some candidates may be left for the next run.");
  }

  Logger.log("Private-Only Enforcer (remote) finished.");
}

// Helper functions. These are generic and contain no client-specific details.

function getOrCreateLabel_(name) {
  var labelIter = AdsApp.labels()
    .withCondition("Name = '" + name + "'")
    .get();

  if (labelIter.hasNext()) {
    return labelIter.next();
  }

  Logger.log("Label " + name + " does not exist; creating it.");
  return AdsApp.createLabel(name);
}

function getLabeledCampaigns_(labelName) {
  var campaigns = [];
  var iterator = AdsApp.campaigns()
    .withCondition("Status = ENABLED")
    .withCondition("LabelNames CONTAINS_ANY ['" + labelName + "']")
    .get();

  while (iterator.hasNext()) {
    var campaign = iterator.next();
    campaigns.push(campaign);
  }
  return campaigns;
}

function getCampaignById_(campaigns, id) {
  for (var i = 0; i < campaigns.length; i++) {
    if (campaigns[i].getId() === id) {
      return campaigns[i];
    }
  }
  return null;
}

function buildExistingExactNegativesMap_(campaigns) {
  var map = {};
  for (var i = 0; i < campaigns.length; i++) {
    var campaign = campaigns[i];
    var campaignId = campaign.getId();
    var negatives = {};
    var kwIter = campaign.negativeKeywords().get();
    while (kwIter.hasNext()) {
      var kw = kwIter.next();
      if (kw.getMatchType && kw.getMatchType() == "EXACT") {
        var text = kw.getText().toLowerCase();
        // Text may already be wrapped with brackets; normalize by stripping them.
        if (text.charAt(0) === "[" && text.charAt(text.length - 1) === "]") {
          text = text.substring(1, text.length - 1);
        }
        negatives[text] = true;
      }
    }
    map[campaignId] = negatives;
  }
  return map;
}

function classifyIntent_(term, keepTokens, suspiciousTokens, brandAllowlist) {
  var lower = term.toLowerCase();
  var matchedKeep = [];
  var matchedSuspicious = [];

  for (var i = 0; i < keepTokens.length; i++) {
    if (lower.indexOf(keepTokens[i]) !== -1) {
      matchedKeep.push(keepTokens[i]);
    }
  }

  for (var j = 0; j < suspiciousTokens.length; j++) {
    if (lower.indexOf(suspiciousTokens[j]) !== -1) {
      matchedSuspicious.push(suspiciousTokens[j]);
    }
  }

  // Allowlist override: if the term includes any brand token, treat as keep.
  for (var k = 0; k < brandAllowlist.length; k++) {
    if (lower.indexOf(brandAllowlist[k].toLowerCase()) !== -1) {
      return {
        intentClass: "keep",
        matchTokens: ["brand:" + brandAllowlist[k]]
      };
    }
  }

  if (matchedKeep.length > 0) {
    return {
      intentClass: "keep",
      matchTokens: matchedKeep
    };
  }

  if (matchedSuspicious.length > 0) {
    return {
      intentClass: "block_candidate",
      matchTokens: matchedSuspicious
    };
  }

  return {
    intentClass: "uncertain",
    matchTokens: []
  };
}

