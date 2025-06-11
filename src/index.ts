import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Re-use the existing helper modules
interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
}

class RateLimiter {
  private rateLimitInfo: RateLimitInfo | null = null;

  updateFromHeaders(headers: Headers): void {
    const limit = headers.get('x-ratelimit-limit');
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    if (limit && remaining && reset) {
      this.rateLimitInfo = {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: new Date(parseInt(reset, 10) * 1000),
      };
    }
  }

  getRateLimitInfo(): RateLimitInfo | null {
    return this.rateLimitInfo;
  }

  isRateLimited(): boolean {
    return this.rateLimitInfo ? this.rateLimitInfo.remaining === 0 : false;
  }

  getTimeUntilReset(): number {
    if (!this.rateLimitInfo) return 0;
    const now = new Date();
    const resetTime = this.rateLimitInfo.reset;
    return Math.max(0, resetTime.getTime() - now.getTime());
  }

  getRateLimitMessage(): string {
    if (!this.rateLimitInfo) return '';
    const { limit, remaining, reset } = this.rateLimitInfo;
    const timeUntilReset = this.getTimeUntilReset();
    const minutesUntilReset = Math.ceil(timeUntilReset / 60000);
    return `Rate limit: ${remaining}/${limit} remaining. Resets in ${minutesUntilReset} minutes.`;
  }
}

// Error handling classes
class InstantlyError extends Error {
  status: number;
  code?: string;
  details?: any;

  constructor(error: { status: number; message: string; code?: string; details?: any }) {
    super(error.message);
    this.name = 'InstantlyError';
    this.status = error.status;
    this.code = error.code;
    this.details = error.details;
  }
}

// Pagination helpers
interface PaginatedResponse<T> {
  data: T[];
  total?: number;
  limit: number;
  hasMore: boolean;
  next_starting_after?: string;
}

function buildQueryParams(args: any, additionalParams: string[] = []): URLSearchParams {
  const query = new URLSearchParams();
  
  if (args?.limit) query.append('limit', String(args.limit));
  if (args?.starting_after) query.append('starting_after', String(args.starting_after));
  
  additionalParams.forEach(param => {
    if (args?.[param]) {
      query.append(param, String(args[param]));
    }
  });
  
  return query;
}

function parsePaginatedResponse<T>(response: any, requestedLimit?: number): PaginatedResponse<T> {
  if (response.data && Array.isArray(response.data)) {
    return {
      data: response.data as T[],
      total: response.total,
      limit: response.limit || requestedLimit || response.data.length,
      hasMore: !!response.next_starting_after,
      next_starting_after: response.next_starting_after,
    };
  }
  
  if (response.items && Array.isArray(response.items)) {
    return {
      data: response.items as T[],
      total: response.total,
      limit: response.limit || requestedLimit || response.items.length,
      hasMore: !!response.next_starting_after,
      next_starting_after: response.next_starting_after,
    };
  }
  
  if (Array.isArray(response)) {
    return {
      data: response as T[],
      limit: requestedLimit || response.length,
      hasMore: false,
    };
  }
  
  return {
    data: [],
    limit: requestedLimit || 0,
    hasMore: false,
  };
}

export class InstantlyMCP extends McpAgent {
  server = new McpServer({
    name: "instantly-mcp",
    version: "4.0.1",
  });

  private INSTANTLY_API_URL = 'https://api.instantly.ai/api/v2';
  private INSTANTLY_API_KEY: string;
  private rateLimiter = new RateLimiter();

  constructor(apiKey: string) {
    super();
    this.INSTANTLY_API_KEY = apiKey;
  }

  // Helper methods
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private validateCampaignData(args: any): void {
    if (args.email_list && Array.isArray(args.email_list)) {
      for (const email of args.email_list) {
        if (!this.isValidEmail(email)) {
          throw new Error(`Invalid email address in email_list: ${email}`);
        }
      }
    }

    if (args.body && typeof args.body !== 'string') {
      throw new Error(`Body must be a plain string, not ${typeof args.body}`);
    }

    if (args.body && args.body.includes('<') && args.body.includes('>')) {
      throw new Error(`Body should not contain HTML tags. Use plain text with \\n for line breaks.`);
    }

    const validTimezones = [
      "Etc/GMT+12", "Etc/GMT+11", "Etc/GMT+10", "America/Anchorage", "America/Dawson",
      "America/Creston", "America/Chihuahua", "America/Boise", "America/Belize",
      "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles",
      "Europe/London", "Europe/Paris", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"
    ];

    if (args.timezone && !validTimezones.includes(args.timezone)) {
      throw new Error(`Invalid timezone: ${args.timezone}. Must be one of: ${validTimezones.join(', ')}`);
    }

    const timeRegex = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
    if (args.timing_from && !timeRegex.test(args.timing_from)) {
      throw new Error(`Invalid timing_from format: ${args.timing_from}. Must be HH:MM format`);
    }
    if (args.timing_to && !timeRegex.test(args.timing_to)) {
      throw new Error(`Invalid timing_to format: ${args.timing_to}. Must be HH:MM format`);
    }
  }

  private async makeInstantlyRequest(endpoint: string, method: string = 'GET', data?: any) {
    if (this.rateLimiter.isRateLimited()) {
      const timeUntilReset = this.rateLimiter.getTimeUntilReset();
      throw new Error(`Rate limit exceeded. Please wait ${Math.ceil(timeUntilReset / 60000)} minutes before retrying.`);
    }

    const url = `${this.INSTANTLY_API_URL}${endpoint}`;
    console.error(`[Instantly MCP] Request: ${method} ${url}`);

    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${this.INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
      console.error(`[Instantly MCP] Request body: ${JSON.stringify(data, null, 2)}`);
    }

    const response = await fetch(url, options);
    console.error(`[Instantly MCP] Response status: ${response.status} ${response.statusText}`);

    this.rateLimiter.updateFromHeaders(response.headers);

    const contentType = response.headers.get('content-type');
    
    if (contentType?.includes('application/json')) {
      const responseData = await response.json();
      
      if (!response.ok) {
        throw new InstantlyError({
          status: response.status,
          message: responseData.error || responseData.message || response.statusText,
          code: responseData.code,
          details: responseData.details || responseData.errors,
        });
      }
      
      return responseData;
    } else {
      const text = await response.text();
      
      if (!response.ok) {
        throw new InstantlyError({
          status: response.status,
          message: text || response.statusText,
        });
      }
      
      return text;
    }
  }

  private async getAllAccountsWithPagination(): Promise<any[]> {
    const allAccounts: any[] = [];
    let startingAfter: string | undefined = undefined;
    let hasMore = true;
    const limit = 100;

    console.error(`[Instantly MCP] Starting complete account retrieval with pagination...`);

    while (hasMore) {
      const queryParams = new URLSearchParams();
      queryParams.append('limit', limit.toString());
      if (startingAfter) {
        queryParams.append('starting_after', startingAfter);
      }

      const endpoint = `/accounts?${queryParams.toString()}`;
      const result = await this.makeInstantlyRequest(endpoint);

      let accounts: any[];
      if (Array.isArray(result)) {
        accounts = result;
        hasMore = false;
      } else if (result && result.data && Array.isArray(result.data)) {
        accounts = result.data;
        hasMore = !!result.next_starting_after;
        startingAfter = result.next_starting_after;
      } else if (result && result.items && Array.isArray(result.items)) {
        accounts = result.items;
        hasMore = !!result.next_starting_after;
        startingAfter = result.next_starting_after;
      } else {
        console.error(`[Instantly MCP] Unexpected response:`, JSON.stringify(result, null, 2));
        throw new Error(`Unable to retrieve accounts. Response format: ${typeof result}`);
      }

      allAccounts.push(...accounts);
      console.error(`[Instantly MCP] Retrieved ${accounts.length} accounts (total so far: ${allAccounts.length})`);

      if (allAccounts.length > 10000) {
        console.error(`[Instantly MCP] Safety limit reached: ${allAccounts.length} accounts retrieved`);
        break;
      }

      if (accounts.length < limit) {
        hasMore = false;
      }
    }

    console.error(`[Instantly MCP] Complete account retrieval finished: ${allAccounts.length} total accounts`);
    return allAccounts;
  }

  private async validateEmailListAgainstAccounts(emailList: string[]): Promise<void> {
    const accounts = await this.getAllAccountsWithPagination();

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts found in your workspace. Please add at least one account before creating campaigns.');
    }

    console.error(`[Instantly MCP] Found ${accounts.length} total accounts`);
    
    const eligibleAccounts = accounts.filter((account: any) => {
      return account.status === 1 && !account.setup_pending && account.email && account.warmup_status === 1;
    });

    console.error(`[Instantly MCP] Found ${eligibleAccounts.length} eligible accounts`);
    
    if (eligibleAccounts.length === 0) {
      const accountStatuses = accounts.map((acc: any) => ({
        email: acc.email,
        status: acc.status,
        setup_pending: acc.setup_pending,
        warmup_status: acc.warmup_status,
        warmup_score: acc.warmup_score
      }));
      
      throw new Error(
        `No eligible sending accounts found. Accounts must be: 1) Active (status=1), 2) Setup complete (setup_pending=false), 3) Warmup active (warmup_status=1). ` +
        `Current account statuses: ${JSON.stringify(accountStatuses, null, 2)}`
      );
    }
    
    const eligibleEmails = new Set<string>();
    const eligibleEmailsForDisplay: string[] = [];
    
    for (const account of eligibleAccounts) {
      eligibleEmails.add(account.email.toLowerCase());
      eligibleEmailsForDisplay.push(`${account.email} (warmup: ${account.warmup_score})`);
    }
    
    const invalidEmails: string[] = [];
    for (const email of emailList) {
      if (!eligibleEmails.has(email.toLowerCase())) {
        invalidEmails.push(email);
      }
    }
    
    if (invalidEmails.length > 0) {
      throw new Error(
        `The following email addresses are not eligible for campaign sending: ${invalidEmails.join(', ')}. ` +
        `Eligible accounts: ${eligibleEmailsForDisplay.join(', ')}`
      );
    }

    console.error(`[Instantly MCP] All ${emailList.length} email addresses validated successfully`);
  }

  async init() {
    // Campaign Management Tools
    this.server.tool(
      "list_campaigns",
      {
        limit: z.number().min(1).max(100).optional().describe("Number of campaigns to return (1-100, default: 20)"),
        starting_after: z.string().optional().describe("ID of the last item from previous page for pagination"),
        search: z.string().optional().describe("Search term to filter campaigns by name"),
        status: z.enum(['active', 'paused', 'completed']).optional().describe("Filter by campaign status"),
      },
      async (args) => {
        const queryParams = buildQueryParams(args, ['search', 'status']);
        const endpoint = `/campaigns${queryParams.toString() ? `?${queryParams}` : ''}`;
        const result = await this.makeInstantlyRequest(endpoint);
        
        const requestedLimit = args.limit || 20;
        const paginatedResult = parsePaginatedResponse(result, requestedLimit);

        const responseText = JSON.stringify(paginatedResult, null, 2);
        const maxResponseSize = 900000;
        
        if (responseText.length > maxResponseSize) {
          console.error(`[Instantly MCP] Response too large, truncating campaigns...`);
          
          const summarizedCampaigns = paginatedResult.data.map((campaign: any) => ({
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            timestamp_created: campaign.timestamp_created,
            timestamp_updated: campaign.timestamp_updated,
            email_list_count: campaign.email_list?.length || 0,
            sequence_steps_count: campaign.sequences?.[0]?.steps?.length || 0,
            daily_limit: campaign.daily_limit,
            organization: campaign.organization
          }));
          
          const truncatedResult = {
            ...paginatedResult,
            data: summarizedCampaigns,
            truncated: true,
            original_count: paginatedResult.data.length,
            message: `Response truncated due to size. Showing summary of ${summarizedCampaigns.length} campaigns.`
          };
          
          return { content: [{ type: "text", text: JSON.stringify(truncatedResult, null, 2) }] };
        }

        return { content: [{ type: "text", text: responseText }] };
      }
    );

    this.server.tool(
      "get_campaign",
      {
        campaign_id: z.string().describe("Campaign ID"),
      },
      async ({ campaign_id }) => {
        const result = await this.makeInstantlyRequest(`/campaigns/${campaign_id}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool(
      "create_campaign",
      {
        name: z.string().describe("Campaign name (REQUIRED)"),
        subject: z.string().describe("Email subject line (REQUIRED)"),
        body: z.string().describe("Email body content (REQUIRED). Use \\n for line breaks"),
        message: z.string().optional().describe("Shortcut: single string with subject and body"),
        email_list: z.array(z.string()).describe("Array of sending account email addresses (REQUIRED)"),
        guided_mode: z.boolean().optional().describe("Enable guided mode for beginners"),
        schedule_name: z.string().optional().describe("Schedule name"),
        timing_from: z.string().optional().describe("Daily start time in HH:MM format"),
        timing_to: z.string().optional().describe("Daily end time in HH:MM format"),
        timezone: z.enum(["Etc/GMT+12", "Etc/GMT+11", "Etc/GMT+10", "America/Anchorage", "America/Dawson", "America/Creston", "America/Chihuahua", "America/Boise", "America/Belize", "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"]).optional(),
        days: z.object({
          monday: z.boolean().optional(),
          tuesday: z.boolean().optional(),
          wednesday: z.boolean().optional(),
          thursday: z.boolean().optional(),
          friday: z.boolean().optional(),
          saturday: z.boolean().optional(),
          sunday: z.boolean().optional(),
        }).optional(),
        sequence_steps: z.number().min(1).max(10).optional().describe("Number of steps in the email sequence"),
        step_delay_days: z.number().min(1).max(30).optional().describe("Days to wait before sending each follow-up"),
        text_only: z.boolean().optional().describe("Send as text-only emails"),
        daily_limit: z.number().min(1).max(1000).optional().describe("Maximum emails to send per day"),
        email_gap_minutes: z.number().min(1).max(1440).optional().describe("Minutes to wait between individual emails"),
        link_tracking: z.boolean().optional().describe("Track link clicks"),
        open_tracking: z.boolean().optional().describe("Track email opens"),
        stop_on_reply: z.boolean().optional().describe("Stop sending when lead replies"),
        stop_on_auto_reply: z.boolean().optional().describe("Stop sending when auto-reply detected"),
      },
      async (args) => {
        // Handle message shortcut
        if (args.message && (!args.subject || !args.body)) {
          const msg = String(args.message).trim();
          let splitIdx = msg.indexOf('.');
          const nlIdx = msg.indexOf('\n');
          if (nlIdx !== -1 && (nlIdx < splitIdx || splitIdx === -1)) splitIdx = nlIdx;
          if (splitIdx === -1) splitIdx = msg.length;
          const subj = msg.slice(0, splitIdx).trim();
          const bod = msg.slice(splitIdx).trim();
          if (!args.subject) args.subject = subj;
          if (!args.body) args.body = bod || subj;
        }

        // Auto-discovery if no email_list provided
        if (!args.email_list || !Array.isArray(args.email_list) || args.email_list.length === 0) {
          console.error('[Instantly MCP] No email_list provided, starting auto-discovery...');

          const accounts = await this.getAllAccountsWithPagination();
          const eligibleAccounts = accounts.filter((a: any) =>
            a.status === 1 && !a.setup_pending && a.warmup_status === 1 && a.email);

          if (eligibleAccounts.length === 0) {
            throw new Error(
              `AUTO-DISCOVERY FAILED: No eligible sending accounts found. ` +
              `Call list_accounts first to see available accounts and their statuses.`
            );
          }

          if (args.guided_mode) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  auto_discovery_result: 'success',
                  message: `Found ${eligibleAccounts.length} eligible sending accounts`,
                  eligible_accounts: eligibleAccounts.map((acc: any, index: number) => ({
                    index: index + 1,
                    email: acc.email,
                    status: acc.status,
                    warmup_score: acc.warmup_score,
                    daily_limit: acc.daily_limit
                  })),
                  guided_mode_instructions: {
                    step: 'account_selection',
                    message: 'Please select which accounts to use for your campaign',
                    next_action: 'Call create_campaign again with guided_mode=false and selected accounts'
                  }
                }, null, 2)
              }]
            };
          }

          const bestAccount = eligibleAccounts.reduce((best: any, current: any) => {
            const bestScore = best.warmup_score || 0;
            const currentScore = current.warmup_score || 0;
            return currentScore > bestScore ? current : best;
          });

          args.email_list = [bestAccount.email];
          console.error(`[Instantly MCP] Auto-selected best sender: ${bestAccount.email}`);
        }

        // Validate required fields
        if (!args.name || !args.subject || !args.body) {
          throw new Error("name, subject, and body are required");
        }

        if (!args.email_list || !Array.isArray(args.email_list) || args.email_list.length === 0) {
          throw new Error("email_list is required and must contain at least one email address");
        }

        // Validate campaign data
        this.validateCampaignData(args);

        // Validate email addresses against available accounts
        await this.validateEmailListAgainstAccounts(args.email_list);

        // Build campaign structure
        const timezone = args.timezone || 'America/New_York';
        const userDays = args.days || {};
        const days = {
          monday: userDays.monday !== false,
          tuesday: userDays.tuesday !== false,
          wednesday: userDays.wednesday !== false,
          thursday: userDays.thursday !== false,
          friday: userDays.friday !== false,
          saturday: userDays.saturday === true,
          sunday: userDays.sunday === true
        };

        const daysConfig: any = {};
        if (days.sunday) daysConfig['0'] = true;
        if (days.monday) daysConfig['1'] = true;
        if (days.tuesday) daysConfig['2'] = true;
        if (days.wednesday) daysConfig['3'] = true;
        if (days.thursday) daysConfig['4'] = true;
        if (days.friday) daysConfig['5'] = true;
        if (days.saturday) daysConfig['6'] = true;
        
        if (Object.keys(daysConfig).length === 0) {
          daysConfig['1'] = true; // Monday
          daysConfig['2'] = true; // Tuesday
          daysConfig['3'] = true; // Wednesday
          daysConfig['4'] = true; // Thursday
          daysConfig['5'] = true; // Friday
        }

        const campaignData: any = {
          name: args.name,
          email_list: args.email_list,
          daily_limit: args.daily_limit || 50,
          email_gap: args.email_gap_minutes || 10,
          link_tracking: args.link_tracking !== undefined ? Boolean(args.link_tracking) : false,
          open_tracking: args.open_tracking !== undefined ? Boolean(args.open_tracking) : false,
          stop_on_reply: args.stop_on_reply !== undefined ? Boolean(args.stop_on_reply) : true,
          stop_on_auto_reply: args.stop_on_auto_reply !== undefined ? Boolean(args.stop_on_auto_reply) : true,
          text_only: args.text_only !== undefined ? Boolean(args.text_only) : false,
          campaign_schedule: {
            schedules: [{
              name: args.schedule_name || 'Default Schedule',
              timing: {
                from: args.timing_from || '09:00',
                to: args.timing_to || '17:00'
              },
              days: daysConfig,
              timezone: timezone
            }]
          }
        };

        // Process body and subject
        let normalizedBody = args.body.trim();
        let normalizedSubject = args.subject.trim();
        
        if (normalizedBody.includes('\n')) {
          normalizedBody = normalizedBody.replace(/\n/g, '\\n');
        }
        
        normalizedBody = normalizedBody.replace(/\r\n/g, '\\n').replace(/\r/g, '\\n');
        normalizedSubject = normalizedSubject.replace(/\n/g, '\\n').replace(/\r\n/g, '\\n').replace(/\r/g, '\\n');

        campaignData.sequences = [{
          steps: [{
            type: 'email',
            delay: 0,
            variants: [{
              subject: normalizedSubject,
              body: normalizedBody,
              v_disabled: false
            }]
          }]
        }];

        // Add multiple sequence steps if requested
        if (args.sequence_steps && Number(args.sequence_steps) > 1) {
          const stepDelayDays = Number(args.step_delay_days) || 3;
          const numSteps = Number(args.sequence_steps);

          for (let i = 1; i < numSteps; i++) {
            let followUpSubject = `Follow-up ${i}: ${String(args.subject)}`.trim();
            followUpSubject = followUpSubject.replace(/\n/g, '\\n').replace(/\r\n/g, '\\n').replace(/\r/g, '\\n');
            
            let followUpBody = `This is follow-up #${i}.\\n\\n${String(args.body)}`.trim();
            followUpBody = followUpBody.replace(/\n/g, '\\n').replace(/\r\n/g, '\\n').replace(/\r/g, '\\n');
            
            campaignData.sequences[0].steps.push({
              type: 'email',
              delay: stepDelayDays,
              variants: [{
                subject: followUpSubject,
                body: followUpBody,
                v_disabled: false
              }]
            });
          }
        }

        const result = await this.makeInstantlyRequest('/campaigns', 'POST', campaignData);

        const enhancedResult = {
          campaign_created: true,
          campaign_details: result,
          workflow_confirmation: {
            prerequisite_followed: true,
            message: 'Campaign created successfully',
            email_validation: 'All email addresses validated',
            accounts_used: campaignData.email_list,
            total_sequence_steps: campaignData.sequences?.[0]?.steps?.length || 1
          },
          next_steps: [
            {
              step: 1,
              action: 'activate_campaign',
              description: 'Activate the campaign to start sending emails',
              tool_call: `activate_campaign {"campaign_id": "${result.id}"}`
            }
          ]
        };

        return { content: [{ type: "text", text: JSON.stringify(enhancedResult, null, 2) }] };
      }
    );

    this.server.tool(
      "activate_campaign",
      {
        campaign_id: z.string().describe("Campaign ID"),
      },
      async ({ campaign_id }) => {
        const result = await this.makeInstantlyRequest(`/campaigns/${campaign_id}/activate`, 'POST');
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // Account Management Tools
    this.server.tool(
      "list_accounts",
      {
        limit: z.number().min(1).max(100).optional().describe("Number of accounts to return"),
        starting_after: z.string().optional().describe("ID for pagination"),
      },
      async (args) => {
        const queryParams = buildQueryParams(args);
        const endpoint = `/accounts${queryParams.toString() ? `?${queryParams}` : ''}`;
        const result = await this.makeInstantlyRequest(endpoint);

        const enhancedResult = {
          ...result,
          campaign_creation_guidance: {
            message: "Use the email addresses from the 'data' array above for campaign creation",
            verified_accounts: result.data?.filter((account: any) =>
              account.status === 'verified' || account.status === 'active' || account.status === 'warmed'
            ).map((account: any) => account.email) || [],
            total_accounts: result.data?.length || 0,
            next_step: "Copy email addresses from verified_accounts for create_campaign email_list"
          }
        };

        return { content: [{ type: "text", text: JSON.stringify(enhancedResult, null, 2) }] };
      }
    );

    // Lead Management Tools
    this.server.tool(
      "list_leads",
      {
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        list_id: z.string().optional().describe("Filter by list ID"),
        status: z.string().optional().describe("Filter by status"),
        limit: z.number().min(1).max(100).optional().describe("Number of leads to return"),
        starting_after: z.string().optional().describe("ID for pagination"),
      },
      async (args) => {
        const requestData: any = {
          limit: args.limit || 20,
          skip: args.starting_after || 0
        };

        if (args.campaign_id) requestData.campaign_id = args.campaign_id;
        if (args.list_id) requestData.list_id = args.list_id;
        if (args.status) requestData.status = args.status;

        const result = await this.makeInstantlyRequest('/leads/list', 'POST', requestData);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool(
      "create_lead",
      {
        email: z.string().email().describe("Lead email address (REQUIRED)"),
        firstName: z.string().optional().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        companyName: z.string().optional().describe("Company name"),
        website: z.string().optional().describe("Company website"),
        personalization: z.string().optional().describe("Personalization field"),
        custom_fields: z.record(z.any()).optional().describe("Custom fields as key-value pairs"),
      },
      async (args) => {
        const leadData: any = { email: args.email };

        if (args.firstName) leadData.first_name = args.firstName;
        if (args.lastName) leadData.last_name = args.lastName;
        if (args.companyName) leadData.company_name = args.companyName;
        if (args.website) leadData.website = args.website;
        if (args.personalization) leadData.personalization = args.personalization;
        if (args.custom_fields) leadData.custom_fields = args.custom_fields;

        const result = await this.makeInstantlyRequest('/leads', 'POST', leadData);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // Email Operations
    this.server.tool(
      "list_emails",
      {
        campaign_id: z.string().optional().describe("Filter by campaign"),
        account_id: z.string().optional().describe("Filter by account"),
        limit: z.number().min(1).max(100).optional().describe("Number of emails to return"),
        starting_after: z.string().optional().describe("ID for pagination"),
      },
      async (args) => {
        const queryParams = buildQueryParams(args, ['campaign_id', 'account_id']);
        const endpoint = `/emails${queryParams.toString() ? `?${queryParams}` : ''}`;
        const result = await this.makeInstantlyRequest(endpoint);
        
        const requestedLimit = args.limit || 20;
        const paginatedResult = parsePaginatedResponse(result, requestedLimit);

        return { content: [{ type: "text", text: JSON.stringify(paginatedResult, null, 2) }] };
      }
    );

    this.server.tool(
      "get_email",
      {
        email_id: z.string().describe("Email ID/UUID"),
      },
      async ({ email_id }) => {
        const result = await this.makeInstantlyRequest(`/emails/${email_id}`);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool(
      "reply_to_email",
      {
        reply_to_uuid: z.string().describe("The ID of the email to reply to (REQUIRED)"),
        eaccount: z.string().describe("The email account to send from (REQUIRED)"),
        subject: z.string().describe("Reply subject line (REQUIRED)"),
        body: z.object({
          html: z.string().optional().describe("HTML body content"),
          text: z.string().optional().describe("Plain text body content"),
        }).describe("Email body content (REQUIRED)"),
        cc_address_email_list: z.string().optional().describe("Comma-separated CC emails"),
        bcc_address_email_list: z.string().optional().describe("Comma-separated BCC emails"),
      },
      async (args) => {
        if (!args.body.html && !args.body.text) {
          throw new Error('body must contain either html or text content');
        }

        const emailData: any = {
          reply_to_uuid: args.reply_to_uuid,
          eaccount: args.eaccount,
          subject: args.subject,
          body: args.body,
        };

        if (args.cc_address_email_list) emailData.cc_address_email_list = args.cc_address_email_list;
        if (args.bcc_address_email_list) emailData.bcc_address_email_list = args.bcc_address_email_list;

        const result = await this.makeInstantlyRequest('/emails/reply', 'POST', emailData);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // Email Verification
    this.server.tool(
      "verify_email",
      {
        email: z.string().email().describe("Email address to verify"),
      },
      async ({ email }) => {
        try {
          const result = await this.makeInstantlyRequest('/email-verification', 'POST', { email });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error: any) {
          if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
            throw new Error(
              `Email verification access denied (403): This feature requires a premium Instantly plan. ` +
              `Please upgrade your plan or contact support.`
            );
          }
          throw error;
        }
      }
    );

    // Analytics
    this.server.tool(
      "get_campaign_analytics",
      {
        campaign_id: z.string().optional().describe("Specific campaign ID"),
        start_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        end_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      },
      async (args) => {
        const queryParams = buildQueryParams(args, ['campaign_id', 'start_date', 'end_date']);
        const endpoint = `/campaigns/analytics${queryParams.toString() ? `?${queryParams}` : ''}`;
        const result = await this.makeInstantlyRequest(endpoint);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // Helper/Debug Tools
    this.server.tool(
      "validate_campaign_accounts",
      {
        email_list: z.array(z.string()).optional().describe("Specific emails to validate"),
      },
      async (args) => {
        const accountsResult = await this.makeInstantlyRequest('/accounts');
        
        let accounts: any[];
        if (Array.isArray(accountsResult)) {
          accounts = accountsResult;
        } else if (accountsResult?.data && Array.isArray(accountsResult.data)) {
          accounts = accountsResult.data;
        } else {
          throw new Error('Unable to retrieve accounts');
        }

        const analysis: any = {
          total_accounts: accounts.length,
          eligible_accounts: [],
          ineligible_accounts: [],
          validation_results: {},
          eligibility_criteria: {
            active_status: 'status must equal 1',
            setup_complete: 'setup_pending must be false',
            warmup_active: 'warmup_status must equal 1',
            has_email: 'email address must be present'
          }
        };

        for (const account of accounts) {
          const accountInfo: any = {
            email: account.email,
            status: account.status,
            setup_pending: account.setup_pending,
            warmup_status: account.warmup_status,
            warmup_score: account.warmup_score,
            eligible: false,
            issues: []
          };

          if (account.status !== 1) accountInfo.issues.push('Account not active');
          if (account.setup_pending) accountInfo.issues.push('Setup still pending');
          if (account.warmup_status !== 1) accountInfo.issues.push('Warmup not active');
          if (!account.email) accountInfo.issues.push('No email address');

          accountInfo.eligible = accountInfo.issues.length === 0;

          if (accountInfo.eligible) {
            analysis.eligible_accounts.push(accountInfo);
          } else {
            analysis.ineligible_accounts.push(accountInfo);
          }

          if (args.email_list?.includes(account.email)) {
            analysis.validation_results[account.email] = accountInfo;
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: any, ctx: ExecutionContext) {
    // Get API key from environment or headers
    const apiKey = env.INSTANTLY_API_KEY || request.headers.get('X-API-Key');
    
    if (!apiKey) {
      return new Response('API key required', { status: 401 });
    }

    const mcp = new InstantlyMCP(apiKey);
    const url = new URL(request.url);
    
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return mcp.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return mcp.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
