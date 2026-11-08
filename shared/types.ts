export type Phase = "LOBBY" | "STORYTELLING" | "SUBMITTING" | "VOTING" | "REVEAL" | "GAME_OVER";

export type LifelineId = "burn" | "freshHand" | "halfLight" | "stall" | "doubleDown" | "passStory";

export interface LifelineMeta {
  id: LifelineId;
  name: string;
  blurb: string;
  icon: string;
  def: number;
}

export const LIFELINES: LifelineMeta[] = [
  { id: "burn",       name: "Burn",          icon: "🔥", def: 2, blurb: "Throw away one card, draw a replacement." },
  { id: "freshHand",  name: "Fresh Hand",    icon: "♻️", def: 1, blurb: "Dump your whole hand, draw a new one." },
  { id: "halfLight",  name: "Half-Light",    icon: "🔎", def: 1, blurb: "Before voting, one wrong card is greyed out for you only." },
  { id: "stall",      name: "Stall",         icon: "⏳", def: 1, blurb: "Add 30 seconds to the current phase, for everyone." },
  { id: "doubleDown", name: "Double Down",   icon: "🎲", def: 1, blurb: "Vote right for +2 extra, vote wrong and lose 1." },
  { id: "passStory",  name: "Pass the Story",icon: "🙈", def: 1, blurb: "Storyteller only: hand the role on and redraw your hand." },
];

export interface Settings {
  maxPlayers: number;
  storytellerSeconds: number;
  submitSeconds: number;
  voteSeconds: number;
  revealSeconds: number;
  endMode: "points" | "rounds";
  pointsTarget: number;
  roundsTarget: number;
  handSize: number;
  voteCapEnabled: boolean;
  autoPlayOnTimeout: boolean;
  requireApproval: boolean;
  clueMaxLength: number;
  lifelines: Record<LifelineId, number>;
}

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 10,
  storytellerSeconds: 90,
  submitSeconds: 60,
  voteSeconds: 45,
  revealSeconds: 14,
  endMode: "points",
  pointsTarget: 30,
  roundsTarget: 12,
  handSize: 6,
  voteCapEnabled: true,
  autoPlayOnTimeout: true,
  requireApproval: false,
  clueMaxLength: 80,
  lifelines: { burn: 2, freshHand: 1, halfLight: 1, stall: 1, doubleDown: 1, passStory: 1 },
};

export const SETTING_BOUNDS = {
  maxPlayers: [3, 10],
  storytellerSeconds: [20, 300],
  submitSeconds: [15, 240],
  voteSeconds: [10, 180],
  revealSeconds: [5, 60],
  pointsTarget: [5, 100],
  roundsTarget: [1, 60],
  handSize: [4, 7],
  clueMaxLength: [10, 140],
  lifeline: [0, 5],
} as const;

export const MIN_PLAYERS = 3;

export interface CardRef {
  id: string;
  img: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  avatar: string;
  score: number;
  connected: boolean;
  isHost: boolean;
  isSpectator: boolean;
  handCount: number;
  hasSubmitted: boolean;
  hasVoted: boolean;
  isStoryteller: boolean;
  lifelinesLeft: Record<LifelineId, number>;
  roundDelta: number;
  doubleDown: boolean;
}

export interface TableCard {
  cardId: string;
  img: string;
  ownerId?: string;
  ownerName?: string;
  isStorytellerCard?: boolean;
  voters?: { id: string; name: string; avatar: string }[];
}

export interface ChatMsg {
  id: string;
  name: string;
  avatar: string;
  text: string;
  ts: number;
  system?: boolean;
}

export interface RoundLogEntry {
  round: number;
  storytellerName: string;
  clue: string;
  storytellerCardImg: string;
  guessedRight: string[];
  skipped?: boolean;
  note?: string;
}

export interface Award {
  icon: string;
  label: string;
  who: string;
  detail: string;
}

export interface YouView {
  id: string;
  name: string;
  isHost: boolean;
  isSpectator: boolean;
  hand: CardRef[];
  lifelinesLeft: Record<LifelineId, number>;
  halfLightExcluded?: string;
  doubleDown: boolean;
  submittedCardId?: string;
  votedCardId?: string;
  isStoryteller: boolean;
}

export interface ClientState {
  code: string;
  phase: Phase;
  round: number;
  settings: Settings;
  players: PublicPlayer[];
  spectators: PublicPlayer[];
  pending: { id: string; name: string; avatar: string }[];
  you: YouView;
  storytellerId?: string;
  clue?: string;
  table: TableCard[];
  submittedCount: number;
  expectedSubmissions: number;
  votedCount: number;
  expectedVotes: number;
  phaseEndsAt?: number;
  deckLeft: number;
  log: RoundLogEntry[];
  chat: ChatMsg[];
  awards?: Award[];
  winners?: string[];
  bans: number;
  reactions: Record<string, string[]>;
}

export const AVATARS = [
  "🦊","🐙","🦉","🐸","🦄","🐳","🦁","🐼","🦋","🐝",
  "🦕","🐧","🦀","🐲","🦩","🐢","🦝","🐞","🦚","🐵",
];
