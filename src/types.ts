export type Platform = "reddit" | "hn";

/** A single piece of authored content, normalized across sources. */
export interface Item {
  platform: Platform;
  id: string;
  kind: "comment" | "post";
  /** Subreddit (reddit) or story title (hn); used for topical context. */
  context: string;
  title?: string;
  body: string;
  createdUtc: number;
  permalink: string;
}

export interface Profile {
  platform: Platform;
  username: string;
  /** Public-facing account URL for this profile. */
  profileUrl: string;
  items: Item[];
  /** Inclusive epoch-seconds span of the fetched history. */
  firstUtc?: number;
  lastUtc?: number;
}

export interface IdentityProof {
  /** Exact account/person label the model can point to from the footprint. */
  exactUser: string;
  /** Why the model believes this maps to the same user. */
  rationale: string;
  /** Public proof URLs: LinkedIn, personal site, portfolio, GitHub, etc. */
  publicProofUrls: string[];
}

/** One inferred fact an attacker could derive from the footprint. */
export interface Finding {
  category:
    | "location"
    | "employer_or_school"
    | "real_name"
    | "age_or_dob"
    | "gender"
    | "relationships_or_family"
    | "financial"
    | "health"
    | "schedule_or_routine"
    | "cross_platform_handle"
    | "external_link"
    | "writing_fingerprint"
    | "other";
  /** What an attacker concludes, in plain language. */
  claim: string;
  confidence: "low" | "medium" | "high";
  /** Why — the reasoning chain over the evidence. */
  rationale: string;
  /** permalinks / quotes that leak it, so the user can find & scrub them. */
  evidence: Array<{ quote: string; permalink: string }>;
  /** Concrete remediation. */
  remediation: string;
}

export interface AuditResult {
  username: string;
  platforms: Platform[];
  platformProfiles: Array<{
    platform: Platform;
    username: string;
    profileUrl: string;
  }>;
  itemCount: number;
  span?: { firstUtc: number; lastUtc: number };
  overallRisk: "low" | "medium" | "high";
  summary: string;
  identity: IdentityProof;
  findings: Finding[];
}
