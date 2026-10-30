export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'offline_qr'
  | 'poll'
  | 'sticker'
  | 'contact';

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];
  /** Server-anonymised polls: non-privileged recipients get voterIds: [] plus
   * this per-option count instead (protocol contract v1). UI counts must use
   * `voterCount ?? voterIds.length`. */
  voterCount?: number;
}

export interface PollData {
  question: string;
  options: PollOption[];
  /** one vote per user when false */
  multiple?: boolean;
  anonymous?: boolean;
  closesAt?: number;
  /** Quiz mode (Phase 1.2): voters pick options and only AFTER voting see
   * which option was correct. NOTE: `correctOptionId` travels with the
   * message payload to every recipient (there is no server-side hiding for
   * it in contract v2), so the reveal is a UX courtesy, not a secrecy
   * guarantee — a modified client could read it before voting. */
  quiz?: boolean;
  correctOptionId?: string;
}

export interface ReplyRef {
  id: string;
  senderName: string;
  snippet: string;
  type: MessageType;
}

export type PresenceStatus = 'online' | 'away' | 'offline';

export type GroupRole = 'admin' | 'moderator' | 'controller' | 'member';

export interface MemberPermissions {
  canCreateSubchannel?: boolean;
  canEditSubchannel?: boolean;
  canDeleteSubchannel?: boolean;
  canPostInLocked?: boolean;
}

export interface User {
  id: string;
  name: string;
  username?: string;
  email?: string;
  avatar: string;
  status: string;
  presence?: PresenceStatus; // 'online' = green, 'away' = yellow, 'offline' = no mark/relative time
  online: boolean;
  lastSeen?: string;
  role?: string;
  isAdmin?: boolean;
}

export interface ReactionMap {
  [emoji: string]: string[];
}

export interface GroupSection {
  id: string;
  name: string; // e.g. "general", "design-team", "ux-writers", "projects"
  isPrivate?: boolean; // locked 🔒
  allowedRoles?: GroupRole[];
  allowedMemberIds?: string[];
  description?: string;
  /** Phase 1.5: read-only announcement section — only owner/admins may post (enforced server-side). */
  readOnly?: boolean;
}

export type ChannelPermissionAudience = 'all' | 'admins';

export interface ChannelPermissions {
  post: ChannelPermissionAudience;
  pin: ChannelPermissionAudience;
  manage: ChannelPermissionAudience;
}

export type GroupEventRsvp = 'yes' | 'no' | 'maybe';

export interface GroupEvent {
  id: string;
  title: string;
  /** epoch ms */
  startsAt: number;
  createdBy: string;
  rsvps: Record<string, GroupEventRsvp>;
}

export interface GroupBookmark {
  id: string;
  title: string;
  url: string;
  addedAt?: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  roomId: string;
  sectionId?: string; // Sub-channel section ID (e.g. '#general', '#design-team')
  type: MessageType;
  content: string; // text, base64 url, or QR data string
  images?: string[];
  fileName?: string;
  fileSize?: string;
  fileType?: string;
  duration?: number;
  timestamp: number;
  reactions?: ReactionMap;
  status?: 'sending' | 'sent' | 'delivered' | 'read';
  isAdmin?: boolean;
  role?: GroupRole;
  replyTo?: ReplyRef;
  editedAt?: number;
  deletedAt?: number;
  pinned?: boolean;
  poll?: PollData;
  forwardedFrom?: string;
  /** disappearing messages: epoch ms after which the message is removed everywhere in this client */
  expiresAt?: number;
  /** sticker messages render extra-large */
  sticker?: boolean;
  /** Receipts (contract v1/v2): user IDs the server has delivered this
   * message to / who have read it. The server pushes these via
   * `message:receipts`; the message-info panel reads them. */
  deliveredTo?: string[];
  readBy?: string[];
  /** Real MIME type for media messages (uploads contract v2). */
  mimeType?: string;
  /** Set when this message is a reply to a story (story id). */
  storyRef?: string;
  /** Contact-card messages: the shared contact's username. The card is
   * tappable and opens that user's ProfileCard. */
  contactCard?: string;
  /** Bundled sticker-pack provenance for type 'sticker' messages
   * (content = asset URL). */
  stickerPack?: string;
  stickerId?: string;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  iconType: 'hash' | 'code' | 'video' | 'general';
  unreadCount?: number;
  isPinned?: boolean;
  isArchived?: boolean;
  isMuted?: boolean;
  avatar?: string;
  bannerImage?: string;
  lastMessage?: string;
  lastMessageTime?: string;
  lastMessageTimestamp?: number;
  createdAt?: number;
  isGroup?: boolean;
  membersCount?: number;
  onlineCount?: number;
  members?: string[];
  adminId?: string; // Creator / Admin ID (legacy — superseded by ownerId/adminIds)
  /** Server contract fields (Phase 0.3): creator recorded at creation;
   * membership and adminship stored by user ID. All optional so locally
   * persisted legacy channels (which may only carry `members`/`adminId`)
   * keep loading. */
  ownerId?: string;
  memberIds?: string[];
  adminIds?: string[];
  memberRoles?: Record<string, GroupRole>; // memberId -> 'admin' | 'moderator' | 'controller' | 'member'
  memberPermissions?: Record<string, MemberPermissions>; // memberId -> granular permission overrides
  rolePermissions?: Record<GroupRole, MemberPermissions>; // default role permissions
  sections?: GroupSection[];
  bookmarks?: GroupBookmark[];
  /** Phase 1.5 (protocol contract v2): invite links, join approval, permission matrix, group events. */
  inviteCode?: string;
  inviteEnabled?: boolean;
  joinApproval?: boolean;
  joinRequests?: string[];
  permissions?: ChannelPermissions;
  events?: GroupEvent[];
}

export interface CallLog {
  id: string;
  user: User;
  type: 'incoming' | 'outgoing' | 'missed' | 'declined';
  callType: 'audio' | 'video';
  date: string;
  time: string;
  duration?: string;
  dataUsed?: string;
}
