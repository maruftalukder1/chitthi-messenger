import React, { useState, useRef } from 'react';
import { Channel, User, ChatMessage, GroupRole, GroupBookmark, GroupSection, MemberPermissions, GroupEvent, GroupEventRsvp, ChannelPermissions } from '../types/chat';
import { formatFullDateTime, formatRelativeTime } from '../utils/timeFormat';
import { authHeaders, type PrivacyAudiences } from '../services/firebase';
import { ProfileCard, type ProfileCardUser } from './ProfileCard';
import { getEffectiveUserPresence } from '../utils/presenceUtils';
import {
  ArrowLeft,
  MoreVertical,
  Bell,
  ChevronDown,
  UserPlus,
  Search,
  Bookmark,
  Image as ImageIcon,
  Video,
  FileText,
  Camera,
  Shield,
  ShieldCheck,
  UserMinus,
  Check,
  Plus,
  Trash2,
  ExternalLink,
  Copy,
  Lock,
  Hash,
  Download,
  X,
  Edit2,
  Sliders,
  MessageSquare,
  Calendar,
  Clock,
  Ban,
  Flag,
  Link2,
  LogOut,
  CalendarPlus,
  Megaphone,
  RefreshCw,
  UserCheck,
  UserX,
  Play,
  Globe
} from 'lucide-react';

// Generated-artefact colours (SVG data-URIs, QR codes) resolve from the live
// design tokens at runtime — Team C's cssToken pattern (Phase 2): no hex
// literals in component files.
function cssToken(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

interface GroupInfoScreenProps {
  channel: Channel;
  users: User[];
  currentUser: User;
  onBack: () => void;
  onSelectMember: (user: User) => void;
  onUpdateChannel: (updatedChannel: Channel) => void;
  lang: 'bn' | 'en';
  onSelectSubchannel?: (sectionId: string) => void;
  /** Phase 1.5 wiring (optional): called after a successful leave / delete so
   * App can drop the channel from its list and navigate to the chat list.
   * When absent, GroupInfo falls back to onBack() (see coordinator notes). */
  onLeaveGroup?: (channelId: string) => void;
  onDeleteGroup?: (channelId: string) => void;
  /** Phase 1.9.3 wiring (optional): the room's actual messages, used to build
   * the real shared-media browser (Images / Videos / Docs / Links tabs).
   * GAP TODAY: App does NOT pass this yet — it owns the message list
   * (`messages` state; `activeRoomMessages` is already computed for
   * ChatViewScreen). Coordinator: pass `messages={activeRoomMessages}` on
   * both GroupInfoScreen mounts. Until then the media tabs honestly render
   * their empty states. */
  messages?: ChatMessage[];
  /** Phase 1.9.3 wiring (optional): tapping a shared-media / link item asks
   * the host to jump to that message in the chat. Coordinator: App should
   * close this panel / return to 'chat_view' and forward the id to
   * ChatViewScreen, which already owns the `msg-${id}` DOM anchors and the
   * `highlightMsgId` flash machinery — it needs a small external
   * jump-target prop to receive it. When absent, item taps are inert
   * (Docs download / Links open-in-new-tab still work). */
  onJumpToMessage?: (messageId: string) => void;
  /** Profile-card wiring (optional): start a 1:1 call with a member from
   * their ProfileCard. GroupInfo has no call machinery of its own and App
   * does not pass one today — coordinator: pass a handler that mirrors the
   * CallsScreen onStartCall body (setCallType / setCallTargetName /
   * setCallSession({direction:'out', peerId: user.id, ...}) /
   * setIsVoiceCallOpen(true)). When absent, the card's Call button simply
   * dismisses the card — no fake call is started. */
  onCallMember?: (user: User) => void;
}

const CURATED_GROUP_AVATARS = [
  'https://images.unsplash.com/photo-1610832958506-aa56368176cf?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=800&q=80',
  'https://images.unsplash.com/photo-1531403009284-440f080d1e12?auto=format&fit=crop&w=800&q=80'
];

export const GroupInfoScreen: React.FC<GroupInfoScreenProps> = ({
  channel,
  users,
  currentUser,
  onBack,
  onSelectMember,
  onUpdateChannel,
  lang,
  onSelectSubchannel,
  onLeaveGroup,
  onDeleteGroup,
  messages,
  onJumpToMessage,
  onCallMember
}) => {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [activeMediaTab, setActiveMediaTab] = useState<'bookmarks' | 'images' | 'videos' | 'docs' | 'links'>('bookmarks');
  const [channelsExpanded, setChannelsExpanded] = useState(true);
  const [memberSearch, setMemberSearch] = useState('');
  const [showMemberSearch, setShowMemberSearch] = useState(false);

  // Group Image change modal & ref
  const [showImageModal, setShowImageModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Bookmark creation state
  const [showAddBookmark, setShowAddBookmark] = useState(false);
  const [newBmTitle, setNewBmTitle] = useState('');
  const [newBmUrl, setNewBmUrl] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Member kick confirmation modal
  const [kickTargetUser, setKickTargetUser] = useState<User | null>(null);

  // Other-user ProfileCard (Phase 1.9.3 follow-up): member-row taps open
  // this card instead of jumping straight into a DM.
  const [profileTarget, setProfileTarget] = useState<User | null>(null);

  // 3-Dot menu state
  const [showDropdownMenu, setShowDropdownMenu] = useState(false);

  // Dedicated 'Admin/Moderator' Management Modal State
  const [showAdminManagementModal, setShowAdminManagementModal] = useState(false);
  const [selectedMemberForPerms, setSelectedMemberForPerms] = useState<User | null>(null);
  const [managementSearch, setManagementSearch] = useState('');

  // Subchannel Edit / Add / Delete states
  const [showAddSubchannelModal, setShowAddSubchannelModal] = useState(false);
  const [newSecName, setNewSecName] = useState('');
  const [newSecDescription, setNewSecDescription] = useState('');
  const [newSecIsPrivate, setNewSecIsPrivate] = useState(false);
  const [newSecReadOnly, setNewSecReadOnly] = useState(false);

  const [editingSubchannel, setEditingSubchannel] = useState<GroupSection | null>(null);
  const [editSecName, setEditSecName] = useState('');
  const [editSecDescription, setEditSecDescription] = useState('');
  const [editSecIsPrivate, setEditSecIsPrivate] = useState(false);
  const [editSecReadOnly, setEditSecReadOnly] = useState(false);

  const [deletingSubchannel, setDeletingSubchannel] = useState<GroupSection | null>(null);

  // ── Phase 1.5: invite links / join requests / leave / delete / add-member / events ──
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [addMemberSearch, setAddMemberSearch] = useState('');
  const [showEventForm, setShowEventForm] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventStartsAt, setNewEventStartsAt] = useState('');

  // Subchannel sections list
  const currentSections: GroupSection[] = channel.sections || [
    { id: 'sec_gen', name: 'General', isPrivate: false, allowedRoles: ['admin', 'moderator', 'controller', 'member'], description: 'Main chat for everyone' },
    { id: 'sec_design', name: 'Design Team', isPrivate: true, allowedRoles: ['admin', 'moderator', 'controller'], description: 'UI/UX team discussions' },
    { id: 'sec_ux', name: 'UX Writer', isPrivate: false, allowedRoles: ['admin', 'moderator', 'controller', 'member'], description: 'Content writing and microcopy' },
    { id: 'sec_proj', name: 'Projects', isPrivate: true, allowedRoles: ['admin', 'moderator'], description: 'Confidential project planning' }
  ];

  // Bookmarks list — real channel data only. The old fallback rewrote every
  // bookmark URL to https://chithi.app/resources (fabricated); a group with
  // no bookmarks now gets an honest empty state.
  const currentBookmarks: GroupBookmark[] = channel.bookmarks || [];

  // Determine if current user is admin of this group — real check against
  // server-persisted membership (Phase 0.2; the old `|| true` bypass made
  // everyone admin): owner, listed admin, legacy adminId, or a persisted
  // 'admin' member role.
  const isUserAdmin =
    currentUser.id === channel.ownerId ||
    (channel.adminIds ? channel.adminIds.includes(currentUser.id) : false) ||
    channel.adminId === currentUser.id ||
    (channel.memberRoles ? channel.memberRoles[currentUser.id] === 'admin' : false);

  // ── Phase 0.3: group state is persisted to the server ────────────────────
  // Membership is stored by user ID everywhere. Legacy channels may still
  // carry display names in `members` — resolve them to IDs via the users
  // list (unresolvable entries are kept verbatim; they may be IDs of users
  // not present in this client's list).
  const resolveMemberIds = (ch: Channel): string[] => {
    if (ch.memberIds && ch.memberIds.length) return Array.from(new Set(ch.memberIds));
    const ids: string[] = [];
    for (const m of ch.members || []) {
      const match = users.find((u) => u.id === m) || users.find((u) => u.name === m);
      const id = match ? match.id : m;
      if (id && !ids.includes(id)) ids.push(id);
    }
    const owner = ch.ownerId || ch.adminId;
    if (owner && !ids.includes(owner)) ids.unshift(owner);
    return ids;
  };

  const resolveAdminIds = (ch: Channel): string[] => {
    if (ch.adminIds && ch.adminIds.length) return Array.from(new Set(ch.adminIds));
    const ids: string[] = [];
    const owner = ch.ownerId || ch.adminId;
    if (owner) ids.push(owner);
    if (ch.memberRoles) {
      for (const [mid, role] of Object.entries(ch.memberRoles)) {
        if (role === 'admin' && !ids.includes(mid)) ids.push(mid);
      }
    }
    return ids;
  };

  // Every group-state change goes through here: local state updates via
  // onUpdateChannel AND the full updated channel (name, sections, memberIds,
  // adminIds, ownerId) is POSTed to /api/channels with contract auth headers
  // so a second device sees identical state.
  const persistChannelUpdate = (updated: Channel) => {
    const memberIds = resolveMemberIds(updated);
    const adminIds = resolveAdminIds(updated);
    const normalized: Channel = {
      ...updated,
      ownerId: updated.ownerId || updated.adminId || channel.ownerId || channel.adminId,
      memberIds,
      adminIds,
      members: memberIds,
      membersCount: memberIds.length || updated.membersCount
    };
    onUpdateChannel(normalized);
    (async () => {
      try {
        const headers = {
          'Content-Type': 'application/json',
          ...(await authHeaders(currentUser.id))
        };
        await fetch('/api/channels', {
          method: 'POST',
          headers,
          body: JSON.stringify(normalized)
        });
      } catch {
        /* best-effort sync — local state is already updated */
      }
    })();
  };

  // ── Phase 1.5: owner / invite / permissions / events derived state ───────
  const isOwner =
    currentUser.id === (channel.ownerId || channel.adminId);
  const inviteLink = channel.inviteCode ? `chitthi://join/${channel.inviteCode}` : '';
  const channelPermissions: ChannelPermissions = channel.permissions || { post: 'all', pin: 'all', manage: 'all' };
  const joinRequestIds: string[] = channel.joinRequests || [];
  const groupEvents: GroupEvent[] = [...(channel.events || [])].sort((a, b) => a.startsAt - b.startsAt);
  const canManageMembersByPermission =
    isUserAdmin || channelPermissions.manage === 'all';

  const handleGenerateInvite = async () => {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}/invite`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`invite_failed_${res.status}`);
      const data: any = await res.json().catch(() => ({}));
      const code: string | undefined = data.inviteCode || data.code || data.channel?.inviteCode;
      if (code) {
        persistChannelUpdate({ ...channel, inviteCode: code, inviteEnabled: true });
      } else if (data.channel) {
        persistChannelUpdate({ ...channel, ...data.channel, inviteEnabled: true });
      } else {
        setInviteError(lang === 'bn' ? 'সার্ভার কোনো কোড দেয়নি' : 'Server returned no invite code');
      }
    } catch {
      setInviteError(lang === 'bn' ? 'ইনভাইট লিংক তৈরি করা যায়নি' : 'Could not generate invite link');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleRevokeInvite = async () => {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}/invite`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error(`revoke_failed_${res.status}`);
      persistChannelUpdate({ ...channel, inviteCode: undefined, inviteEnabled: false });
    } catch {
      setInviteError(lang === 'bn' ? 'ইনভাইট বাতিল করা যায়নি' : 'Could not revoke invite link');
    } finally {
      setInviteBusy(false);
    }
  };

  const handleToggleJoinApproval = () => {
    persistChannelUpdate({ ...channel, joinApproval: !channel.joinApproval });
  };

  const handleApproveJoinRequest = (userId: string) => {
    const remaining = joinRequestIds.filter((id) => id !== userId);
    const ids = resolveMemberIds(channel);
    const nextIds = ids.includes(userId) ? ids : [...ids, userId];
    persistChannelUpdate({
      ...channel,
      memberIds: nextIds,
      members: nextIds,
      membersCount: nextIds.length,
      joinRequests: remaining
    });
  };

  const handleRejectJoinRequest = (userId: string) => {
    persistChannelUpdate({ ...channel, joinRequests: joinRequestIds.filter((id) => id !== userId) });
  };

  const handleCopyInvite = () => {
    if (!inviteLink) return;
    navigator.clipboard?.writeText(inviteLink);
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  };

  const handleLeaveGroup = () => {
    const remainingIds = resolveMemberIds(channel).filter((id) => id !== currentUser.id);
    const updatedRoles = { ...(channel.memberRoles || {}) };
    delete updatedRoles[currentUser.id];
    persistChannelUpdate({
      ...channel,
      memberIds: remainingIds,
      members: remainingIds,
      adminIds: resolveAdminIds(channel).filter((id) => id !== currentUser.id),
      memberRoles: updatedRoles,
      membersCount: remainingIds.length
    });
    setShowLeaveConfirm(false);
    // Dedicated wiring preferred; fallback is the existing back callback.
    if (onLeaveGroup) onLeaveGroup(channel.id); else onBack();
  };

  const handleDeleteGroup = async () => {
    if (deleteConfirmText.trim() !== channel.name) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new Error(`delete_failed_${res.status}`);
      setShowDeleteConfirm(false);
      if (onDeleteGroup) onDeleteGroup(channel.id); else onBack();
    } catch {
      setDeleteError(lang === 'bn' ? 'গ্রুপ ডিলিট করা যায়নি (শুধু মালিক পারবেন)' : 'Could not delete group (owner only)');
    } finally {
      setDeleteBusy(false);
    }
  };

  const handlePermissionChange = (key: keyof ChannelPermissions, value: 'all' | 'admins') => {
    persistChannelUpdate({ ...channel, permissions: { ...channelPermissions, [key]: value } });
  };

  // Add-member: membership is by user ID only (Phase 0.3 normalisation).
  const handleAddMemberById = (userId: string) => {
    const ids = resolveMemberIds(channel);
    if (ids.includes(userId)) return;
    const nextIds = [...ids, userId];
    persistChannelUpdate({ ...channel, memberIds: nextIds, members: nextIds, membersCount: nextIds.length });
  };

  const handleCreateEvent = (e: React.FormEvent) => {
    e.preventDefault();
    const title = newEventTitle.trim();
    if (!title || !newEventStartsAt) return;
    const startsAt = new Date(newEventStartsAt).getTime();
    if (!Number.isFinite(startsAt)) return;
    const ev: GroupEvent = {
      id: `evt_${Date.now()}`,
      title,
      startsAt,
      createdBy: currentUser.id,
      rsvps: { [currentUser.id]: 'yes' }
    };
    persistChannelUpdate({ ...channel, events: [...(channel.events || []), ev] });
    setNewEventTitle('');
    setNewEventStartsAt('');
    setShowEventForm(false);
  };

  const handleRsvp = (eventId: string, answer: GroupEventRsvp) => {
    const next = (channel.events || []).map((ev) =>
      ev.id === eventId ? { ...ev, rsvps: { ...(ev.rsvps || {}), [currentUser.id]: answer } } : ev
    );
    persistChannelUpdate({ ...channel, events: next });
  };

  const handleDeleteEvent = (eventId: string) => {
    persistChannelUpdate({ ...channel, events: (channel.events || []).filter((ev) => ev.id !== eventId) });
  };

  // ── Phase 0.11: Block / Report ────────────────────────────────────────────
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  React.useEffect(() => {
    (async () => {
      try {
        const headers = await authHeaders(currentUser.id);
        const res = await fetch('/api/blocks', { headers });
        if (res.ok) {
          const data = await res.json();
          setBlockedIds(Array.isArray(data.blocked) ? data.blocked : []);
        }
      } catch {
        /* blocks list unavailable — row actions still offered */
      }
    })();
  }, [currentUser.id]);

  const blockUser = async (userId: string, userName: string) => {
    if (!window.confirm(lang === 'bn' ? `আপনি কি "${userName}" কে ব্লক করতে চান?` : `Block "${userName}"? They won't be able to message or call you.`)) return;
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch('/api/blocks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ blockedId: userId })
      });
      if (res.ok) setBlockedIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    } catch {
      /* ignore */
    }
  };

  const unblockUser = async (userId: string) => {
    try {
      const headers = await authHeaders(currentUser.id);
      const res = await fetch(`/api/blocks/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers
      });
      if (res.ok) setBlockedIds((prev) => prev.filter((id) => id !== userId));
    } catch {
      /* ignore */
    }
  };

  const reportUser = async (userId: string, userName: string) => {
    const reason = window.prompt(
      lang === 'bn' ? `"${userName}" সম্পর্কে রিপোর্টের কারণ (ঐচ্ছিক):` : `Report "${userName}" — reason (optional):`,
      ''
    );
    if (reason === null) return; // cancelled
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders(currentUser.id)) };
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers,
        body: JSON.stringify({ reportedId: userId, reason: reason || undefined })
      });
      // Report implies block server-side — reflect the blocked state here.
      if (res.ok) setBlockedIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
    } catch {
      /* ignore */
    }
  };

  // Filtered members in group — membership matched by user ID only (never
  // by display name; renames/duplicate names must not corrupt membership).
  const memberIdList = resolveMemberIds(channel);
  const filteredMembers = users.filter((u) => {
    const inGroup = memberIdList.length === 0 || memberIdList.includes(u.id);
    const matchesSearch = u.name.toLowerCase().includes(memberSearch.toLowerCase());
    return inGroup && matchesSearch;
  });
  const displayMemberCount = memberIdList.length || channel.membersCount || filteredMembers.length;

  // ── Phase 1.9.3: REAL shared-media browser ──────────────────────────────
  // Everything below is derived from the room's actual messages (the
  // optional `messages` prop — see the gap note on the prop). Tombstones
  // (deletedAt) never contribute media or links. Newest first.
  const safeMediaUrl = (u: string): string => (/^(data:|blob:|https?:)/i.test(u || '') ? u : '#');
  const roomMessages: ChatMessage[] = (messages || [])
    .filter((m) => (!m.roomId || m.roomId === channel.id) && !m.deletedAt)
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);

  interface SharedImageItem { messageId: string; url: string; timestamp: number; senderName: string }
  const sharedImages: SharedImageItem[] = [];
  for (const m of roomMessages) {
    if (m.type !== 'image') continue;
    const urls = m.images && m.images.length ? m.images : m.content ? [m.content] : [];
    for (const url of urls) {
      if (url) sharedImages.push({ messageId: m.id, url, timestamp: m.timestamp, senderName: m.senderName });
    }
  }
  const sharedVideos = roomMessages.filter((m) => m.type === 'video' && !!m.content);
  const sharedDocs = roomMessages.filter((m) => m.type === 'file');

  interface SharedLinkItem { messageId: string; url: string; domain: string; timestamp: number; senderName: string }
  const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/gi;
  const sharedLinks: SharedLinkItem[] = [];
  for (const m of roomMessages) {
    if (m.type !== 'text' || !m.content) continue;
    const found = m.content.match(URL_IN_TEXT) || [];
    for (const raw of found) {
      const url = raw.replace(/[.,!?;:]+$/, '');
      let domain = '';
      try {
        domain = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        domain = url.replace(/^https?:\/\//, '').split('/')[0];
      }
      sharedLinks.push({ messageId: m.id, url, domain, timestamp: m.timestamp, senderName: m.senderName });
    }
  }

  const handleJumpToMessage = (messageId: string) => {
    if (onJumpToMessage) onJumpToMessage(messageId);
  };
  const mediaJumpCursor = onJumpToMessage ? 'cursor-pointer' : '';

  // ── ProfileCard (other-user) ─────────────────────────────────────────────
  // The local User record may carry directory fields (about / privacy /
  // lastSeenAt) when App merged them in; they are not on the base User
  // type, so read them defensively and pass through whatever is present —
  // ProfileCard tolerates absence.
  const toProfileCardUser = (member: User): ProfileCardUser => {
    const extra = member as User & { about?: string; privacy?: PrivacyAudiences; lastSeenAt?: number };
    return {
      id: member.id,
      name: member.name,
      username: member.username,
      avatar: member.avatar,
      about: typeof extra.about === 'string' ? extra.about : undefined,
      status: member.status,
      online: member.online,
      presence: member.presence,
      lastSeen: member.lastSeen,
      lastSeenAt: typeof extra.lastSeenAt === 'number' ? extra.lastSeenAt : undefined,
      privacy: extra.privacy,
      // Group co-membership is the 'contacts' relationship (contract v2).
      isContact: true
    };
  };

  const sharedMediaCountFor = (userId: string): number =>
    roomMessages.filter(
      (m) => m.senderId === userId && (m.type === 'image' || m.type === 'video' || m.type === 'file')
    ).length;

  // Helper to get effective permissions of a member
  const getMemberPermissions = (memberId: string, role: GroupRole): MemberPermissions => {
    // 1. Check custom overrides
    if (channel.memberPermissions && channel.memberPermissions[memberId]) {
      return channel.memberPermissions[memberId];
    }
    // 2. Fallback to default role permissions
    if (role === 'admin') {
      return {
        canCreateSubchannel: true,
        canEditSubchannel: true,
        canDeleteSubchannel: true,
        canPostInLocked: true
      };
    }
    if (role === 'moderator') {
      return {
        canCreateSubchannel: true,
        canEditSubchannel: true,
        canDeleteSubchannel: true,
        canPostInLocked: true
      };
    }
    if (role === 'controller') {
      return {
        canCreateSubchannel: true,
        canEditSubchannel: true,
        canDeleteSubchannel: false,
        canPostInLocked: true
      };
    }
    return {
      canCreateSubchannel: false,
      canEditSubchannel: false,
      canDeleteSubchannel: false,
      canPostInLocked: false
    };
  };

  const currentUserRole: GroupRole =
    (channel.memberRoles && channel.memberRoles[currentUser.id]) ||
    (currentUser.isAdmin || currentUser.role === 'admin' ? 'admin' : 'member');
  const currentUserPerms = getMemberPermissions(currentUser.id, currentUserRole);

  const canCurrentUserEditSubchannel =
    isUserAdmin ||
    Boolean(currentUserPerms.canEditSubchannel ?? (currentUserRole === 'admin' || currentUserRole === 'moderator'));

  const canCurrentUserDeleteSubchannel =
    isUserAdmin ||
    Boolean(currentUserPerms.canDeleteSubchannel ?? (currentUserRole === 'admin' || currentUserRole === 'moderator'));

  const canCurrentUserCreateSubchannel =
    isUserAdmin ||
    Boolean(currentUserPerms.canCreateSubchannel ?? (currentUserRole === 'admin' || currentUserRole === 'moderator'));

  // Update member role
  const handleRoleChange = (memberId: string, newRole: GroupRole) => {
    const updatedRoles = { ...(channel.memberRoles || {}) };
    updatedRoles[memberId] = newRole;

    // Reset or adapt default permissions
    const updatedPerms = { ...(channel.memberPermissions || {}) };
    updatedPerms[memberId] = getMemberPermissions(memberId, newRole);

    // Promote/demote keeps the server-contract adminIds list in step.
    const updatedAdminIds =
      newRole === 'admin'
        ? Array.from(new Set([...resolveAdminIds(channel), memberId]))
        : resolveAdminIds(channel).filter((id) => id !== memberId);

    const updated: Channel = {
      ...channel,
      memberRoles: updatedRoles,
      memberPermissions: updatedPerms,
      adminIds: updatedAdminIds
    };
    persistChannelUpdate(updated);
  };

  // Toggle specific permission for a member
  const handleTogglePermission = (memberId: string, key: keyof MemberPermissions) => {
    const currentRole: GroupRole =
      (channel.memberRoles && channel.memberRoles[memberId]) || 'member';
    const currentPerms = getMemberPermissions(memberId, currentRole);

    const updatedMemberPerms: MemberPermissions = {
      ...currentPerms,
      [key]: !currentPerms[key]
    };

    const updatedPermissionsMap = {
      ...(channel.memberPermissions || {}),
      [memberId]: updatedMemberPerms
    };

    const updated: Channel = {
      ...channel,
      memberPermissions: updatedPermissionsMap
    };
    persistChannelUpdate(updated);
  };

  // Quick preset assignment for a member
  const handleApplyPreset = (memberId: string, preset: 'moderator' | 'editor' | 'member') => {
    let newRole: GroupRole = 'member';
    let newPerms: MemberPermissions = {};

    if (preset === 'moderator') {
      newRole = 'moderator';
      newPerms = {
        canCreateSubchannel: true,
        canEditSubchannel: true,
        canDeleteSubchannel: true,
        canPostInLocked: true
      };
    } else if (preset === 'editor') {
      newRole = 'controller';
      newPerms = {
        canCreateSubchannel: true,
        canEditSubchannel: true,
        canDeleteSubchannel: false,
        canPostInLocked: true
      };
    } else {
      newRole = 'member';
      newPerms = {
        canCreateSubchannel: false,
        canEditSubchannel: false,
        canDeleteSubchannel: false,
        canPostInLocked: false
      };
    }

    const updatedRoles = { ...(channel.memberRoles || {}), [memberId]: newRole };
    const updatedPermsMap = { ...(channel.memberPermissions || {}), [memberId]: newPerms };

    const updated: Channel = {
      ...channel,
      memberRoles: updatedRoles,
      memberPermissions: updatedPermsMap,
      // Presets never grant admin — a preset applied to an admin demotes them.
      adminIds: resolveAdminIds(channel).filter((id) => id !== memberId)
    };
    persistChannelUpdate(updated);
  };

  // Handle Add Subchannel
  const handleCreateSubchannel = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newSecName.replace(/^[#\s]+/, '').trim().toLowerCase();
    if (!cleanName) return;

    const newSection: GroupSection = {
      id: `sec_${Date.now()}`,
      name: cleanName,
      isPrivate: newSecIsPrivate,
      readOnly: newSecReadOnly,
      description: newSecDescription.trim() || `Channel discussions for #${cleanName}`,
      allowedRoles: newSecIsPrivate
        ? (['admin', 'moderator', 'controller'] as GroupRole[])
        : (['admin', 'moderator', 'controller', 'member'] as GroupRole[])
    };

    const updated: Channel = {
      ...channel,
      sections: [...currentSections, newSection]
    };

    persistChannelUpdate(updated);
    setNewSecName('');
    setNewSecDescription('');
    setNewSecIsPrivate(false);
    setNewSecReadOnly(false);
    setShowAddSubchannelModal(false);
  };

  // Open Edit Subchannel modal
  const openEditSubchannel = (sec: GroupSection) => {
    setEditingSubchannel(sec);
    setEditSecName(sec.name);
    setEditSecDescription(sec.description || '');
    setEditSecIsPrivate(Boolean(sec.isPrivate));
    setEditSecReadOnly(Boolean(sec.readOnly));
  };

  // Save Edited Subchannel
  const handleSaveEditSubchannel = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSubchannel) return;
    const cleanName = editSecName.replace(/^[#\s]+/, '').trim().toLowerCase();
    if (!cleanName) return;

    const updatedSections = currentSections.map((s) => {
      if (s.id === editingSubchannel.id) {
        return {
          ...s,
          name: cleanName,
          description: editSecDescription.trim(),
          isPrivate: editSecIsPrivate,
          readOnly: editSecReadOnly,
          allowedRoles: editSecIsPrivate
            ? (['admin', 'moderator', 'controller'] as GroupRole[])
            : (['admin', 'moderator', 'controller', 'member'] as GroupRole[])
        };
      }
      return s;
    });

    const updated: Channel = {
      ...channel,
      sections: updatedSections
    };

    persistChannelUpdate(updated);
    setEditingSubchannel(null);
  };

  // Confirm Delete Subchannel
  const handleConfirmDeleteSubchannel = () => {
    if (!deletingSubchannel) return;

    // Filter out deleted subchannel
    const updatedSections = currentSections.filter((s) => s.id !== deletingSubchannel.id);
    const updated: Channel = {
      ...channel,
      sections: updatedSections
    };

    persistChannelUpdate(updated);
    setDeletingSubchannel(null);
  };

  // Handle Image Upload for Group Avatar / Cover
  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const updated: Channel = {
        ...channel,
        avatar: dataUrl,
        bannerImage: dataUrl
      };
      persistChannelUpdate(updated);
      setShowImageModal(false);
    };
    reader.readAsDataURL(file);
  };

  const handleSelectCuratedAvatar = (url: string) => {
    const updated: Channel = {
      ...channel,
      avatar: url,
      bannerImage: url
    };
    persistChannelUpdate(updated);
    setShowImageModal(false);
  };

  // Handle Kick Member
  const confirmKickMember = () => {
    if (!kickTargetUser) return;
    const memberId = kickTargetUser.id;

    // Membership is by user ID: remove exactly this ID from memberIds (and
    // from adminIds / memberRoles), and DERIVE the count from the new list.
    // Double-decrement root cause (Phase 0.3): this handler used to set
    // membersCount = old - 1 AND call onKickMember, whose App-side handler
    // decremented the count a second time. The full updated channel is now
    // applied exactly once via persistChannelUpdate. (The former App-side
    // onKickMember callback was deliberately never called after this fix
    // and was removed as dead code in Phase 4.)
    const remainingIds = resolveMemberIds(channel).filter((id) => id !== memberId);
    const updatedRoles = { ...(channel.memberRoles || {}) };
    delete updatedRoles[memberId];
    const updated: Channel = {
      ...channel,
      memberIds: remainingIds,
      members: remainingIds,
      adminIds: resolveAdminIds(channel).filter((id) => id !== memberId),
      memberRoles: updatedRoles,
      membersCount: remainingIds.length
    };
    persistChannelUpdate(updated);
    setKickTargetUser(null);
  };

  // Handle Add Bookmark
  const handleAddBookmark = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBmTitle.trim()) return;

    const newBm: GroupBookmark = {
      id: `bm_${Date.now()}`,
      title: newBmTitle.trim(),
      // No fabricated fallback URL — an empty URL renders as plain text.
      url: newBmUrl.trim(),
      addedAt: formatRelativeTime(Date.now(), lang)
    };

    const updated: Channel = {
      ...channel,
      bookmarks: [newBm, ...currentBookmarks]
    };
    persistChannelUpdate(updated);
    setNewBmTitle('');
    setNewBmUrl('');
    setShowAddBookmark(false);
  };

  // Delete Bookmark
  const handleDeleteBookmark = (bmId: string) => {
    const updated: Channel = {
      ...channel,
      bookmarks: currentBookmarks.filter((b) => b.id !== bmId)
    };
    persistChannelUpdate(updated);
  };

  const handleCopyLink = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Honest banner fallback (Phase 0.4): a plain solid emerald brand tile, never a
  // stock photo presented as the group's own banner.
  const displayBanner =
    channel.bannerImage ||
    channel.avatar ||
    `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='400'><rect width='800' height='400' fill='${cssToken('--c-primary', '#0B6E4F')}'/></svg>`
    )}`;

  // Role Counts for quick stats
  const adminCount = filteredMembers.filter((m) => {
    const r = (channel.memberRoles && channel.memberRoles[m.id]) || (m.isAdmin || m.role === 'admin' ? 'admin' : 'member');
    return r === 'admin';
  }).length;
  const modCount = filteredMembers.filter((m) => {
    const r = (channel.memberRoles && channel.memberRoles[m.id]) || (m.role === 'Moderator' ? 'moderator' : 'member');
    return r === 'moderator';
  }).length;
  const controllerCount = filteredMembers.filter((m) => {
    const r = (channel.memberRoles && channel.memberRoles[m.id]) || 'member';
    return r === 'controller';
  }).length;

  return (
    <div className="flex-1 flex flex-col h-full bg-surface  overflow-y-auto select-none relative">
      {/* Hidden file input for Group Image */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleImageFileChange}
        accept="image/*"
        className="hidden"
      />

      {/* Top Banner Image with Change Photo action */}
      <div className="relative h-56 sm:h-64 w-full bg-pressed  shrink-0 group">
        <img src={displayBanner} alt={channel.name} className="w-full h-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70" />

        {/* Action Header on Banner */}
        <div className="absolute top-4 left-4 right-4 flex items-center justify-between text-white z-10">
          <button
            onClick={onBack}
            className="w-11 h-11 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
            title="Go Back" aria-label="Go Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="relative">
            <button
              onClick={() => setShowDropdownMenu(!showDropdownMenu)}
              className="w-11 h-11 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
              title="Group Options"
             aria-label="Group Options" aria-expanded={showDropdownMenu} aria-haspopup="menu" >
              <MoreVertical className="w-5 h-5" />
            </button>

            {/* 3-Dot Dropdown Menu on Banner */}
            {showDropdownMenu && (
              <div
                className="glass-sheet rounded-[var(--r-sheet)] absolute right-0 top-full mt-2 w-64 py-2 z-30 text-app text-xs animate-in fade-in transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="menu"
                onMouseLeave={() => setShowDropdownMenu(false)}
              >
                {/* 1. Admin/Moderator Management */}
                {isUserAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowDropdownMenu(false);
                      setShowAdminManagementModal(true);
                    }}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-bubble-in  flex items-center gap-2.5 font-bold text-primary  border-b border-token "
                  >
                    <ShieldCheck className="w-4 h-4" />
                    <span>{lang === 'bn' ? 'এডমিন/মডারেটর পারমিশন' : 'Admin & Moderator Management'}</span>
                  </button>
                )}

                {/* 2. Change Group Image */}
                <button
                  type="button"
                  onClick={() => {
                    setShowDropdownMenu(false);
                    setShowImageModal(true);
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-bubble-in  flex items-center gap-2.5 font-semibold text-primary "
                >
                  <Camera className="w-4 h-4" />
                  <span>{lang === 'bn' ? 'গ্রুপের ছবি পরিবর্তন করুন' : 'Change Group Image'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowDropdownMenu(false);
                    setShowAddBookmark(true);
                    setActiveMediaTab('bookmarks');
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-bubble-in  flex items-center gap-2.5 font-medium"
                 aria-pressed={activeMediaTab === 'bookmarks'} >
                  <Bookmark className="w-4 h-4 text-away" />
                  <span>{lang === 'bn' ? 'নতুন বুকমার্ক পিন করুন' : 'Add Pinned Bookmark'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowDropdownMenu(false);
                    setNotificationsEnabled(!notificationsEnabled);
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-bubble-in  flex items-center gap-2.5 font-medium"
                >
                  <Bell className="w-4 h-4 text-app-2" />
                  <span>
                    {notificationsEnabled
                      ? lang === 'bn'
                        ? 'নোটিফিকেশন মিউট করুন'
                        : 'Mute Notifications'
                      : lang === 'bn'
                      ? 'নোটিফিকেশন চালু করুন'
                      : 'Unmute Notifications'}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Change Photo Pill Button directly on Banner */}
        <button
          onClick={() => setShowImageModal(true)}
          className="absolute bottom-4 right-4 px-3 min-h-[44px] rounded-full bg-black/50 hover:bg-black/70 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-md active:scale-95"
          title="Change Group Image" aria-label="Change Group Image"
        >
          <Camera className="w-3.5 h-3.5" />
          <span>{lang === 'bn' ? 'ছবি পরিবর্তন' : 'Change Photo'}</span>
        </button>

        {/* Group Name & Member count on Banner */}
        <div className="absolute bottom-4 left-5 text-white">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight drop-shadow-md flex items-center gap-2 bn-safe bn-text">
            <span>{channel.name}</span>
          </h2>
          <p className="text-xs text-white/85 drop-shadow-xs font-medium mt-0.5">
            {displayMemberCount} {lang === 'bn' ? 'জন সদস্য' : 'members'}
          </p>
        </div>
      </div>

      {/* Description & Notifications Toggle */}
      <div className="p-5 space-y-4 bg-app  border-b border-token ">
        <p className="text-xs sm:text-sm text-app-2  leading-relaxed">
          {channel.description || 'Fullsnack collaborative workspace channel with Discord-like subchannels & role governance.'}
        </p>

        {/* Real-time Group Meta: Creation Date & Last Activity */}
        <div className="flex flex-wrap items-center gap-3 pt-2 text-[11px] text-app-2  border-t border-token ">
          <div className="flex items-center gap-1.5 bg-surface  px-2.5 py-1 rounded-lg">
            <Calendar className="w-3.5 h-3.5 text-primary shrink-0" />
            <span>
              {lang === 'bn' ? 'তৈরি হয়েছে: ' : 'Created: '}
              <strong className="text-app  font-semibold">
                {formatFullDateTime(channel.createdAt || (Date.now() - 3 * 24 * 3600 * 1000), lang)}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-1.5 bg-surface  px-2.5 py-1 rounded-lg">
            <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
            <span>
              {lang === 'bn' ? 'সর্বশেষ অ্যাক্টিভিটি: ' : 'Last activity: '}
              <strong className="text-app  font-semibold">
                {formatRelativeTime(channel.lastMessageTimestamp || channel.createdAt, lang)}
              </strong>
            </span>
          </div>
        </div>

        {/* Notification Switch */}
        <div className="flex items-center justify-between pt-2 border-t border-token ">
          <div className="flex items-center gap-2.5 text-app  text-xs sm:text-sm font-medium">
            <Bell className="w-4 h-4 text-app-2" />
            <span>{lang === 'bn' ? 'নোটিফিকেশন' : 'Notifications'}</span>
          </div>

          <button
            onClick={() => setNotificationsEnabled(!notificationsEnabled)}
            className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
              notificationsEnabled ? 'bg-primary' : 'bg-pressed '
            }`}
           role="switch" aria-checked={notificationsEnabled} aria-label={lang === 'bn' ? 'নোটিফিকেশন' : 'Notifications'} >
            <div
              className={`bg-app w-4 h-4 rounded-full shadow-md transform transition-transform ${
                notificationsEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 🛡️ PROMINENT ADMIN & MODERATOR MANAGEMENT INTERFACE CARD IN GROUP VIEW    */}
      {/* (User Requested: Admin/Moderator management interface in group details)    */}
      {/* ========================================================================= */}
      {isUserAdmin && (
        <div className="mx-4 my-3 p-4 rounded-[var(--r-card)] bg-surface border border-token shadow-xs space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-primary text-white flex items-center justify-center shadow-md  shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-xs sm:text-sm font-bold text-app  flex items-center gap-1.5">
                  <span>{lang === 'bn' ? 'এডমিন ও মডারেটর ম্যানেজমেন্ট' : 'Admin & Moderator Governance'}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-bubble-in  text-primary  font-bold uppercase">
                    Admin
                  </span>
                </h3>
                <p className="text-[11px] text-app-2  mt-0.5 leading-snug">
                  {lang === 'bn'
                    ? 'মেম্বারদের ভূমিকা দিন এবং সাবচ্যানেল এডিট ও ডিলিট করার স্পেসিফিক পারমিশন নির্ধারণ করুন।'
                    : 'Assign roles to members, granting them specific permissions for editing and deleting subchannels.'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAdminManagementModal(true)}
              className="px-3 py-1.5 bg-primary hover:brightness-110 text-white rounded-xl text-xs font-bold shadow-md  flex items-center gap-1.5 transition-colors shrink-0 active:scale-95"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>{lang === 'bn' ? 'পারমিশন কনফিগার' : 'Manage Roles'}</span>
            </button>
          </div>

          {/* Quick Stats Badges */}
          <div className="flex items-center gap-2 flex-wrap text-[11px] pt-1 border-t border-token ">
            <span className="font-semibold text-app-2 ">
              {lang === 'bn' ? 'রোল সারাংশ:' : 'Role Summary:'}
            </span>
            <span className="px-2 py-0.5 rounded-lg bg-bubble-in  text-primary  font-bold">
              👑 {adminCount || 1} Admin
            </span>
            <span className="px-2 py-0.5 rounded-lg bg-bubble-in  text-primary  font-bold">
              🛡️ {modCount} Moderator
            </span>
            <span className="px-2 py-0.5 rounded-lg bg-bubble-in  text-primary  font-bold">
              ⚙️ {controllerCount} Controller
            </span>
            <span className="px-2 py-0.5 rounded-lg bg-pressed  text-app  font-medium">
              👤 {Math.max(0, filteredMembers.length - (adminCount || 1) - modCount - controllerCount)} Members
            </span>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 🔗 PHASE 1.5 — INVITE LINKS, JOIN REQUESTS, PERMISSIONS, EVENTS          */}
      {/* ========================================================================= */}
      {isUserAdmin && (
        <div className="bg-app  mt-2 border-y border-token  p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold text-app">{lang === 'bn' ? 'ইনভাইট লিংক' : 'Invite link'}</h3>
          </div>
          {channel.inviteCode && channel.inviteEnabled !== false ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate text-xs bg-surface  border border-token  rounded-xl px-3 py-2">{inviteLink}</code>
                <button type="button" onClick={handleCopyInvite} className="px-3 py-2 bg-primary text-white rounded-xl text-xs font-bold flex items-center gap-1 shrink-0">
                  {inviteCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{inviteCopied ? (lang === 'bn' ? 'কপি হয়েছে' : 'Copied') : (lang === 'bn' ? 'কপি' : 'Copy')}</span>
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" disabled={inviteBusy} onClick={handleGenerateInvite} className="px-3 py-1.5 bg-bubble-in  rounded-xl text-xs font-semibold flex items-center gap-1 disabled:opacity-50">
                  <RefreshCw className="w-3.5 h-3.5" /> {lang === 'bn' ? 'নতুন লিংক' : 'Regenerate'}
                </button>
                <button type="button" disabled={inviteBusy} onClick={handleRevokeInvite} className="px-3 py-1.5 bg-surface  text-danger  border border-token  rounded-xl text-xs font-semibold disabled:opacity-50">
                  {lang === 'bn' ? 'লিংক বাতিল' : 'Revoke'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" disabled={inviteBusy} onClick={handleGenerateInvite} className="px-3 py-2 bg-primary text-white rounded-xl text-xs font-bold disabled:opacity-50">
              {inviteBusy ? (lang === 'bn' ? 'তৈরি হচ্ছে…' : 'Generating…') : (lang === 'bn' ? 'ইনভাইট লিংক তৈরি করুন' : 'Generate invite link')}
            </button>
          )}
          {inviteError && <p className="text-[11px] text-danger">{inviteError}</p>}
          <div className="flex items-center justify-between pt-2 border-t border-token ">
            <div>
              <span className="text-xs font-bold text-app  block">{lang === 'bn' ? 'যোগদানে অনুমোদন লাগবে' : 'Require join approval'}</span>
              <span className="text-[10px] text-app-faint block">{lang === 'bn' ? 'নতুন সদস্যরা অনুমোদনের পর যোগ দেবে' : 'New members join only after an admin approves'}</span>
            </div>
            <button type="button" onClick={handleToggleJoinApproval} className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${channel.joinApproval ? 'bg-primary' : 'bg-pressed '}`} role="switch" aria-checked={channel.joinApproval} aria-label={lang === 'bn' ? 'যোগদানে অনুমোদন লাগবে' : 'Require join approval'} >
              <div className={`bg-app w-4 h-4 rounded-full shadow-md transform transition-transform ${channel.joinApproval ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          {channel.joinApproval && (
            <div className="space-y-2 pt-1">
              <p className="text-xs font-bold text-app ">{lang === 'bn' ? 'যোগদানের অনুরোধ' : 'Join requests'} ({joinRequestIds.length})</p>
              {joinRequestIds.length === 0 && <p className="text-[11px] text-app-faint">{lang === 'bn' ? 'কোনো অনুরোধ নেই' : 'No pending requests'}</p>}
              {joinRequestIds.map((uid) => {
                const reqUser = users.find((u) => u.id === uid);
                return (
                  <div key={uid} className="flex items-center justify-between gap-2 p-2 rounded-xl bg-surface  border border-token ">
                    <div className="flex items-center gap-2 min-w-0">
                      {reqUser?.avatar ? <img src={reqUser.avatar} alt={reqUser.name} className="w-8 h-8 rounded-full object-cover" /> : null}
                      <span className="text-xs font-semibold truncate bn-safe bn-text">{reqUser?.name || uid}</span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" onClick={() => handleApproveJoinRequest(uid)} className="px-2 py-1 bg-online text-white rounded-lg text-[11px] font-bold flex items-center gap-1"><UserCheck className="w-3 h-3" />{lang === 'bn' ? 'অনুমোদন' : 'Approve'}</button>
                      <button type="button" onClick={() => handleRejectJoinRequest(uid)} className="px-2 py-1 bg-app  border border-token  rounded-lg text-[11px] font-bold flex items-center gap-1"><UserX className="w-3 h-3" />{lang === 'bn' ? 'বাতিল' : 'Reject'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Permission matrix (Phase 1.5) */}
      <div className="bg-app  mt-2 border-y border-token  p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-bold text-app">{lang === 'bn' ? 'গ্রুপ পারমিশন' : 'Group permissions'}</h3>
        </div>
        {([
          { key: 'post', label: lang === 'bn' ? 'কে পোস্ট করতে পারবে' : 'Who can post', desc: lang === 'bn' ? 'চ্যানেলে মেসেজ পাঠানো' : 'Send messages in this group' },
          { key: 'pin', label: lang === 'bn' ? 'কে পিন করতে পারবে' : 'Who can pin', desc: lang === 'bn' ? 'মেসেজ পিন করা' : 'Pin messages' },
          { key: 'manage', label: lang === 'bn' ? 'কে সদস্য পরিচালনা করতে পারবে' : 'Who can manage members', desc: lang === 'bn' ? 'সদস্য যোগ/বাদ ও সেকশন পরিচালনা' : 'Add/remove members & manage sections' }
        ] as { key: keyof ChannelPermissions; label: string; desc: string }[]).map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-xs font-bold text-app  block">{row.label}</span>
              <span className="text-[10px] text-app-faint block">{row.desc}</span>
            </div>
            {isUserAdmin ? (
              <select value={channelPermissions[row.key]} onChange={(e) => handlePermissionChange(row.key, e.target.value as 'all' | 'admins')} className="text-[11px] font-bold py-1.5 px-2 rounded-lg bg-bubble-in  border border-token  shrink-0" aria-label={row.label} >
                <option value="all">{lang === 'bn' ? 'সবাই' : 'Everyone'}</option>
                <option value="admins">{lang === 'bn' ? 'শুধু এডমিন' : 'Admins only'}</option>
              </select>
            ) : (
              <span className="text-[11px] font-bold px-2 py-1 rounded-lg bg-bubble-in  shrink-0">{channelPermissions[row.key] === 'admins' ? (lang === 'bn' ? 'শুধু এডমিন' : 'Admins only') : (lang === 'bn' ? 'সবাই' : 'Everyone')}</span>
            )}
          </div>
        ))}
      </div>

      {/* Group events (Phase 1.5) */}
      <div className="bg-app  mt-2 border-y border-token  p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold text-app">{lang === 'bn' ? 'গ্রুপ ইভেন্ট' : 'Group events'} ({groupEvents.length})</h3>
          </div>
          <button type="button" onClick={() => setShowEventForm(!showEventForm)} className="px-2.5 py-1 bg-surface  text-primary  border border-token  rounded-xl text-xs font-semibold flex items-center gap-1">
            <CalendarPlus className="w-3.5 h-3.5" /> {lang === 'bn' ? 'নতুন ইভেন্ট' : 'New event'}
          </button>
        </div>
        {showEventForm && (
          <form onSubmit={handleCreateEvent} className="p-3 bg-surface  border border-token  rounded-2xl space-y-2">
            <input type="text" value={newEventTitle} onChange={(e) => setNewEventTitle(e.target.value)} required placeholder={lang === 'bn' ? 'ইভেন্টের নাম…' : 'Event title…'} className="w-full p-2 bg-app  border border-token  rounded-xl text-xs"  aria-label={lang === 'bn' ? 'ইভেন্টের নাম' : 'Event title'} />
            <input type="datetime-local" value={newEventStartsAt} onChange={(e) => setNewEventStartsAt(e.target.value)} required className="w-full p-2 bg-app  border border-token  rounded-xl text-xs"  aria-label={lang === 'bn' ? 'ইভেন্ট শুরুর সময়' : 'Event start time'} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowEventForm(false)} className="px-3 py-1.5 text-xs text-app-2">{lang === 'bn' ? 'বাতিল' : 'Cancel'}</button>
              <button type="submit" className="px-3 py-1.5 bg-primary text-white rounded-xl text-xs font-bold">{lang === 'bn' ? 'তৈরি করুন' : 'Create event'}</button>
            </div>
          </form>
        )}
        {groupEvents.length === 0 && !showEventForm && <p className="text-xs text-app-2 text-center py-2">{lang === 'bn' ? 'এখনো কোনো ইভেন্ট নেই' : 'No events yet'}</p>}
        <div className="space-y-2">
          {groupEvents.map((ev) => {
            const rsvps = ev.rsvps || {};
            const counts = { yes: 0, no: 0, maybe: 0 };
            Object.values(rsvps).forEach((v) => { counts[v] += 1; });
            const mine = rsvps[currentUser.id];
            return (
              <div key={ev.id} className="p-3 rounded-2xl bg-surface  border border-token  space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-app truncate bn-safe bn-text">{ev.title}</p>
                    <p className="text-[11px] text-app-faint">{formatFullDateTime(ev.startsAt, lang)}</p>
                  </div>
                  {(isUserAdmin || ev.createdBy === currentUser.id) && (
                    <button type="button" onClick={() => handleDeleteEvent(ev.id)} className="p-1 text-app-faint hover:text-danger" title="Delete event" aria-label="Delete event"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
                <p className="text-[11px] text-app-2">✓ {counts.yes} · ? {counts.maybe} · ✕ {counts.no}</p>
                <div className="flex items-center gap-1.5">
                  {(['yes', 'maybe', 'no'] as GroupEventRsvp[]).map((ans) => (
                    <button key={ans} type="button" onClick={() => handleRsvp(ev.id, ans)} className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${mine === ans ? 'bg-primary text-white border-[var(--c-primary)]' : 'bg-app  border-token  text-app-2 '}`} aria-pressed={mine === ans} >
                      {ans === 'yes' ? (lang === 'bn' ? 'যাচ্ছি' : 'Going') : ans === 'maybe' ? (lang === 'bn' ? 'হয়তো' : 'Maybe') : (lang === 'bn' ? 'যাচ্ছি না' : "Can't go")}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 🏷️ SUB-CHANNELS SECTION WITH EDIT, DELETE & ADD CAPABILITIES             */}
      {/* (User requested: can delete UX Writer or any subchannel with permission)  */}
      {/* ========================================================================= */}
      <div className="bg-app  mt-2 border-y border-token ">
        <div className="p-4 flex items-center justify-between text-xs font-bold text-app  border-b border-token ">
          <button
            onClick={() => setChannelsExpanded(!channelsExpanded)}
            className="flex items-center gap-2 hover:text-primary transition-colors"
           aria-expanded={channelsExpanded} >
            <span className="w-2.5 h-2.5 rounded-full bg-primary" />
            <span className="text-sm">
              {currentSections.length} {lang === 'bn' ? 'টি সাবচ্যানেল (Sub-channels)' : 'Sub-channels'}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-app-faint transition-transform ${channelsExpanded ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Add Subchannel Button (for user with permission) */}
          {canCurrentUserCreateSubchannel && (
            <button
              type="button"
              onClick={() => setShowAddSubchannelModal(true)}
              className="px-2.5 py-1 bg-surface  text-primary  hover:bg-bubble-in  border border-token  rounded-xl text-xs font-semibold flex items-center gap-1 transition-colors active:scale-95"
              title="Add New Subchannel" aria-label="Add New Subchannel"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{lang === 'bn' ? 'নতুন সাবচ্যানেল' : 'Add Subchannel'}</span>
            </button>
          )}
        </div>

        {channelsExpanded && (
          <div className="p-3 space-y-2 text-xs animate-in fade-in">
            {currentSections.map((sec) => {
              const isDefaultGeneral = sec.id === 'sec_gen' || sec.name.toLowerCase() === 'general';

              return (
                <div
                  key={sec.id}
                  className="p-3 rounded-2xl bg-surface  hover:bg-bubble-in  border border-token  flex items-center justify-between gap-3 text-app  transition-colors group"
                >
                  {/* Click to open subchannel chat directly */}
                  <div
                    onClick={() => onSelectSubchannel && onSelectSubchannel(sec.id)}
                    className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer"
                    title={lang === 'bn' ? `#${sec.name} সাবচ্যানেলে চ্যাট করুন` : `Open #${sec.name} subchannel chat`}
                  >
                    <div className="w-7 h-7 rounded-lg bg-bubble-in  text-primary  flex items-center justify-center shrink-0">
                      <Hash className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-app  truncate">
                          {sec.name}
                        </span>
                        {sec.isPrivate ? (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-away  bg-surface  px-2 py-0.5 rounded-md border border-token  shrink-0">
                            <Lock className="w-2.5 h-2.5" />
                            <span>{lang === 'bn' ? 'লকড' : 'Locked'}</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-app-faint font-medium shrink-0">Public</span>
                        )}
                        {sec.readOnly && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-primary  bg-surface  px-2 py-0.5 rounded-md border border-token  shrink-0">
                            <Megaphone className="w-2.5 h-2.5" />
                            <span>{lang === 'bn' ? 'ঘোষণা' : 'Announcements'}</span>
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-app-faint truncate mt-0.5">
                        {sec.description || (lang === 'bn' ? `#${sec.name} এর জন্য ডেডিকেটেড ডিসকাশন` : `Dedicated chat for #${sec.name}`)}
                      </p>
                    </div>
                  </div>

                  {/* Actions for Subchannel: Edit & Delete buttons */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* 1. Edit Subchannel Button */}
                    {canCurrentUserEditSubchannel && (
                      <button
                        type="button"
                        onClick={() => openEditSubchannel(sec)}
                        className="p-1.5 text-app-faint hover:text-primary  hover:bg-app  rounded-lg transition-colors"
                        title={lang === 'bn' ? 'সাবচ্যানেল এডিট করুন' : 'Edit subchannel name & settings'} aria-label={lang === 'bn' ? 'সাবচ্যানেল এডিট করুন' : 'Edit subchannel name & settings'}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* 2. Delete Subchannel Button (Disabled for General to prevent breaking group) */}
                    {canCurrentUserDeleteSubchannel && !isDefaultGeneral && (
                      <button
                        type="button"
                        onClick={() => setDeletingSubchannel(sec)}
                        className="p-1.5 text-app-faint hover:text-danger  hover:bg-surface  rounded-lg transition-colors"
                        title={lang === 'bn' ? `"${sec.name}" সাবচ্যানেল মুছে ফেলুন` : `Delete "${sec.name}" subchannel`} aria-label={lang === 'bn' ? `"${sec.name}" সাবচ্যানেল মুছে ফেলুন` : `Delete "${sec.name}" subchannel`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Quick Chat Shortcut */}
                    {onSelectSubchannel && (
                      <button
                        type="button"
                        onClick={() => onSelectSubchannel(sec.id)}
                        className="p-1.5 text-app-faint hover:text-primary rounded-lg hover:bg-surface  transition-colors"
                        title="Open Chat" aria-label="Open Chat"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Media & Resource Tabs (Bookmarks, Images, Videos, Docs) */}
      <div className="bg-app  mt-2 border-y border-token ">
        <div className="flex items-center justify-between px-5 border-b border-token  text-xs font-semibold overflow-x-auto no-scrollbar">
          <button
            onClick={() => setActiveMediaTab('bookmarks')}
            className={`py-3 flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
              activeMediaTab === 'bookmarks'
                ? 'border-[var(--c-primary)] text-primary '
                : 'border-transparent text-app-2  hover:text-app '
            }`}
           aria-pressed={activeMediaTab === 'bookmarks'} >
            <Bookmark className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'বুকমার্ক' : 'Bookmarks'} ({currentBookmarks.length})</span>
          </button>

          <button
            onClick={() => setActiveMediaTab('images')}
            className={`py-3 flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
              activeMediaTab === 'images'
                ? 'border-[var(--c-primary)] text-primary '
                : 'border-transparent text-app-2  hover:text-app '
            }`}
           aria-pressed={activeMediaTab === 'images'} >
            <ImageIcon className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'ছবি' : 'Images'} ({sharedImages.length})</span>
          </button>

          <button
            onClick={() => setActiveMediaTab('videos')}
            className={`py-3 flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
              activeMediaTab === 'videos'
                ? 'border-[var(--c-primary)] text-primary '
                : 'border-transparent text-app-2  hover:text-app '
            }`}
           aria-pressed={activeMediaTab === 'videos'} >
            <Video className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'ভিডিও' : 'Videos'} ({sharedVideos.length})</span>
          </button>

          <button
            onClick={() => setActiveMediaTab('docs')}
            className={`py-3 flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
              activeMediaTab === 'docs'
                ? 'border-[var(--c-primary)] text-primary '
                : 'border-transparent text-app-2  hover:text-app '
            }`}
           aria-pressed={activeMediaTab === 'docs'} >
            <FileText className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'ডকুমেন্ট' : 'Docs'} ({sharedDocs.length})</span>
          </button>

          <button
            onClick={() => setActiveMediaTab('links')}
            className={`py-3 flex items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors ${
              activeMediaTab === 'links'
                ? 'border-[var(--c-primary)] text-primary '
                : 'border-transparent text-app-2  hover:text-app '
            }`}
           aria-pressed={activeMediaTab === 'links'} >
            <Link2 className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'লিংক' : 'Links'} ({sharedLinks.length})</span>
          </button>
        </div>

        {/* Tab Content Display */}
        <div className="p-4">
          {/* 1. Bookmarks Tab */}
          {activeMediaTab === 'bookmarks' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-app ">
                  {lang === 'bn' ? 'পিন করা লিংক ও রিসোর্স' : 'Pinned Links & Bookmarks'}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAddBookmark(!showAddBookmark)}
                  className="text-xs font-semibold text-primary  hover:underline flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{lang === 'bn' ? 'বুকমার্ক যোগ করুন' : 'Add Bookmark'}</span>
                </button>
              </div>

              {/* Add Bookmark Form */}
              {showAddBookmark && (
                <form
                  onSubmit={handleAddBookmark}
                  className="p-3 bg-surface  border border-token  rounded-2xl space-y-2 animate-in fade-in"
                >
                  <input
                    type="text"
                    value={newBmTitle}
                    onChange={(e) => setNewBmTitle(e.target.value)}
                    placeholder={lang === 'bn' ? 'বুকমার্কের নাম বা শিরোনাম...' : 'Bookmark title or note...'} aria-label={lang === 'bn' ? 'বুকমার্কের নাম বা শিরোনাম...' : 'Bookmark title or note...'}
                    required
                    className="w-full p-2 bg-app  border border-token  rounded-xl text-xs"
                  />
                  <input
                    type="url"
                    value={newBmUrl}
                    onChange={(e) => setNewBmUrl(e.target.value)}
                    placeholder="https://example.com/project-link"
                    className="w-full p-2 bg-app  border border-token  rounded-xl text-xs"
                   aria-label={lang === 'bn' ? 'বুকমার্কের URL' : 'Bookmark URL'} />
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAddBookmark(false)}
                      className="px-3 py-1.5 text-xs text-app-2 hover:text-app"
                    >
                      {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                    </button>
                    <button
                      type="submit"
                      className="px-3 py-1.5 bg-primary text-white rounded-xl text-xs font-bold"
                    >
                      {lang === 'bn' ? 'সংরক্ষণ' : 'Save'}
                    </button>
                  </div>
                </form>
              )}

              {/* Bookmark Items List */}
              <div className="space-y-2">
                {currentBookmarks.map((bm) => (
                  <div
                    key={bm.id}
                    className="p-3 bg-surface  rounded-xl border border-token  flex items-start justify-between gap-3 text-xs group"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-app truncate bn-safe bn-text">{bm.title}</p>
                      {bm.url ? (
                        <a
                          href={bm.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-primary  hover:underline flex items-center gap-1 mt-0.5 truncate"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          <span className="truncate">{bm.url}</span>
                        </a>
                      ) : (
                        <span className="text-[11px] text-app-faint mt-0.5 block">
                          {lang === 'bn' ? 'কোনো লিংক নেই' : 'No link'}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleCopyLink(bm.id, bm.url)}
                        className="p-1 text-app-faint hover:text-app-2  rounded"
                        title="Copy URL" aria-label="Copy URL"
                      >
                        {copiedId === bm.id ? (
                          <Check className="w-3.5 h-3.5 text-online" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {isUserAdmin && (
                        <button
                          onClick={() => handleDeleteBookmark(bm.id)}
                          className="p-1 text-app-faint hover:text-danger rounded"
                          title="Delete Bookmark" aria-label="Delete Bookmark"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {currentBookmarks.length === 0 && (
                  <div className="text-xs text-app-2 py-4 text-center">
                    <Bookmark className="w-8 h-8 mx-auto text-app-faint mb-1" />
                    <p>{lang === 'bn' ? 'এখনো কোনো বুকমার্ক নেই' : 'No bookmarks yet'}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 2. Images Tab — real grid from the room's image messages
              (Phase 1.9.3; replaces the Phase 0 honest empty state, which
              remains for groups with no shared images) */}
          {activeMediaTab === 'images' && (
            sharedImages.length === 0 ? (
              <div className="text-xs text-app-2 py-4 text-center">
                <ImageIcon className="w-8 h-8 mx-auto text-app-faint mb-1" />
                <p>{lang === 'bn' ? 'এখনো কোনো ছবি শেয়ার করা হয়নি' : 'No shared media yet'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {sharedImages.map((item, idx) => (
                  <button
                    key={`${item.messageId}_${idx}`}
                    type="button"
                    onClick={() => handleJumpToMessage(item.messageId)}
                    className={`relative aspect-square rounded-xl overflow-hidden bg-bubble-in  group ${mediaJumpCursor}`}
                    title={lang === 'bn' ? `${item.senderName} · ${formatRelativeTime(item.timestamp, lang)}` : `${item.senderName} · ${formatRelativeTime(item.timestamp, lang)}`} aria-label={lang === 'bn' ? `${item.senderName} · ${formatRelativeTime(item.timestamp, lang)}` : `${item.senderName} · ${formatRelativeTime(item.timestamp, lang)}`}
                  >
                    <img src={safeMediaUrl(item.url)} alt={lang === 'bn' ? 'শেয়ার করা ছবি' : 'Shared image'} loading="lazy" className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform" />
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent text-white text-[9px] font-medium px-1.5 pt-3 pb-1 text-left truncate opacity-0 group-hover:opacity-100 transition-opacity">
                      {item.senderName}
                    </span>
                  </button>
                ))}
              </div>
            )
          )}

          {/* 3. Videos Tab — real video messages, tap jumps to the message */}
          {activeMediaTab === 'videos' && (
            sharedVideos.length === 0 ? (
              <div className="text-xs text-app-2 py-4 text-center">
                <Video className="w-8 h-8 mx-auto text-app-faint mb-1" />
                <p>{lang === 'bn' ? 'এখনো কোনো ভিডিও শেয়ার করা হয়নি' : 'No shared videos yet'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {sharedVideos.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleJumpToMessage(m.id)}
                    className={`relative rounded-xl overflow-hidden bg-badge aspect-video text-left group ${mediaJumpCursor}`}
                    title={`${m.senderName} · ${formatRelativeTime(m.timestamp, lang)}`} aria-label={`${m.senderName} · ${formatRelativeTime(m.timestamp, lang)}`}
                  >
                    <video src={safeMediaUrl(m.content)} preload="metadata" muted playsInline className="w-full h-full object-cover opacity-90" />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-9 h-9 rounded-full bg-black/55  text-white flex items-center justify-center group-hover:scale-110 transition-transform">
                        <Play className="w-4 h-4 fill-current ml-0.5" />
                      </span>
                    </span>
                    <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent text-white text-[9px] font-medium px-2 pt-4 pb-1.5 truncate">
                      {m.senderName} · {formatRelativeTime(m.timestamp, lang)}
                    </span>
                  </button>
                ))}
              </div>
            )
          )}

          {/* 4. Docs Tab — real file messages with name / size / date and a
              download action; row tap jumps to the message */}
          {activeMediaTab === 'docs' && (
            sharedDocs.length === 0 ? (
              <div className="text-xs text-app-2 py-4 text-center">
                <FileText className="w-8 h-8 mx-auto text-app-faint mb-1" />
                <p>{lang === 'bn' ? 'এখনো কোনো ডকুমেন্ট শেয়ার করা হয়নি' : 'No shared documents yet'}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sharedDocs.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => handleJumpToMessage(m.id)}
                    className={`p-3 bg-surface  rounded-xl border border-token  flex items-center gap-3 text-xs ${mediaJumpCursor}`}
                  >
                    <div className="p-2 bg-primary text-white rounded-lg shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-app  truncate">{m.fileName || (lang === 'bn' ? 'শেয়ার করা ডকুমেন্ট' : 'Shared Document')}</p>
                      <p className="text-[10px] text-app-faint truncate mt-0.5">
                        {[m.fileSize, formatFullDateTime(m.timestamp, lang), m.senderName].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <a
                      href={safeMediaUrl(m.content)}
                      download={m.fileName || 'download'}
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 text-primary  hover:bg-pressed  rounded-lg transition-colors shrink-0"
                      title={lang === 'bn' ? 'ডাউনলোড' : 'Download file'}
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  </div>
                ))}
              </div>
            )
          )}

          {/* 5. Links Tab — URLs extracted from the room's text messages,
              with domain + sender; row tap jumps to the message */}
          {activeMediaTab === 'links' && (
            sharedLinks.length === 0 ? (
              <div className="text-xs text-app-2 py-4 text-center">
                <Link2 className="w-8 h-8 mx-auto text-app-faint mb-1" />
                <p>{lang === 'bn' ? 'এখনো কোনো লিংক শেয়ার করা হয়নি' : 'No shared links yet'}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sharedLinks.map((item, idx) => (
                  <div
                    key={`${item.messageId}_${idx}`}
                    onClick={() => handleJumpToMessage(item.messageId)}
                    className={`p-3 bg-surface  rounded-xl border border-token  flex items-center gap-3 text-xs ${mediaJumpCursor}`}
                  >
                    <div className="p-2 bg-pressed  text-app-2  rounded-lg shrink-0">
                      <Globe className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-primary  truncate">{item.domain}</p>
                      <p className="text-[11px] text-app-2  truncate mt-0.5">{item.url}</p>
                      <p className="text-[10px] text-app-faint mt-0.5">
                        {item.senderName} · {formatRelativeTime(item.timestamp, lang)}
                      </p>
                    </div>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 text-app-faint hover:text-primary  rounded-lg transition-colors shrink-0"
                      title={lang === 'bn' ? 'লিংক খুলুন' : 'Open link'}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Member Directory: "12 Peoples" with Role Badges & Inline Permissions Toggle */}
      <div className="bg-app  mt-2 mb-10 border-y border-token ">
        <div className="flex items-center justify-between p-4 border-b border-token ">
          <div>
            <span className="text-xs font-bold text-app ">
              {filteredMembers.length} {lang === 'bn' ? 'জন মেম্বার' : 'Peoples / Members'}
            </span>
            {isUserAdmin && (
              <p className="text-[10px] text-app-faint mt-0.5">
                {lang === 'bn'
                  ? 'মেম্বারদের ভূমিকা ও সাবচ্যানেল পারমিশন কনফিগার করুন'
                  : 'Configure member roles & subchannel edit/delete rights'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 text-app-2">
            {canManageMembersByPermission && (
              <button
                type="button"
                onClick={() => setShowAddMemberModal(true)}
                className="px-2.5 py-1 text-xs font-semibold bg-surface  text-primary  border border-token  rounded-xl hover:bg-bubble-in transition-colors flex items-center gap-1"
                title="Add member" aria-label="Add member"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'যোগ করুন' : 'Add'}</span>
              </button>
            )}
            {isUserAdmin && (
              <button
                type="button"
                onClick={() => setShowAdminManagementModal(true)}
                className="px-2.5 py-1 text-xs font-semibold bg-surface  text-primary  border border-token  rounded-xl hover:bg-bubble-in transition-colors flex items-center gap-1"
                title="Manage Roles" aria-label="Manage Roles"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'ম্যানেজ' : 'Roles'}</span>
              </button>
            )}
            <button
              onClick={() => setShowMemberSearch(!showMemberSearch)}
              className="p-1.5 hover:text-primary rounded-lg hover:bg-bubble-in  transition-colors"
              title="Search member" aria-label="Search member"
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
        </div>

        {showMemberSearch && (
          <div className="px-4 py-2 border-b border-token ">
            <input
              type="text"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder={lang === 'bn' ? 'মেম্বার খুঁজুন...' : 'Search members...'} aria-label={lang === 'bn' ? 'মেম্বার খুঁজুন...' : 'Search members...'}
              className="w-full text-xs p-2 bg-bubble-in  rounded-xl "
            />
          </div>
        )}

        {/* Member Items List */}
        <div className="divide-y divide-[var(--c-border)] ">
          {filteredMembers.map((member) => {
            const isMe = member.id === currentUser.id;
            const currentRole: GroupRole =
              (channel.memberRoles && channel.memberRoles[member.id]) ||
              (member.isAdmin || member.role === 'admin' ? 'admin' : member.role === 'Moderator' ? 'moderator' : 'member');
            const perms = getMemberPermissions(member.id, currentRole);
            const isExpanded = selectedMemberForPerms?.id === member.id;

            return (
              <div
                key={member.id}
                className="p-3.5 hover:bg-surface  transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div
                    onClick={() => {
                      // Other-user rows open the ProfileCard (Message / Call /
                      // Block live there now); your own row is inert — the old
                      // behaviour jumped straight into a DM.
                      if (!isMe) setProfileTarget(member);
                    }}
                    className={`flex items-center gap-3 min-w-0 flex-1 mr-2 ${isMe ? '' : 'cursor-pointer'}`}
                  >
                    <div className="relative shrink-0">
                      <img
                        src={member.avatar}
                        alt={member.name}
                        className="w-10 h-10 rounded-full bg-pressed  object-cover shrink-0"
                      />
                      {getEffectiveUserPresence(member) === 'online' && (
                        <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-online ring-2 ring-white " title="Online" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs sm:text-sm font-bold text-app truncate flex items-center gap-1.5 bn-safe bn-text">
                        <span>{member.name}</span>
                        {isMe && <span className="text-app-faint font-normal">({lang === 'bn' ? 'আপনি' : 'You'})</span>}
                      </p>
                      {/* Active Permission Badges */}
                      <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-app-faint truncate max-w-[100px]">
                          {member.status || 'Active'}
                        </span>
                        {perms.canEditSubchannel && (
                          <span className="text-[9px] font-semibold text-primary  bg-surface  px-1.5 py-0.2 rounded border border-token ">
                            ✏️ Edit Subchannel
                          </span>
                        )}
                        {perms.canDeleteSubchannel && (
                          <span className="text-[9px] font-semibold text-danger  bg-surface  px-1.5 py-0.2 rounded border border-token ">
                            🗑️ Delete Subchannel
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Role Badge & Controls */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isUserAdmin && !isMe ? (
                      <>
                        {/* Role Selector Dropdown */}
                        <select
                          value={currentRole}
                          onChange={(e) => handleRoleChange(member.id, e.target.value as GroupRole)}
                          className="text-[11px] font-bold py-1 px-2 rounded-lg bg-bubble-in  text-app  border border-token   cursor-pointer"
                         aria-label={`Role for ${member.name}`} >
                          <option value="admin">Admin</option>
                          <option value="moderator">Moderator</option>
                          <option value="controller">Controller</option>
                          <option value="member">Member</option>
                        </select>

                        {/* Inline Expand Permission Toggles */}
                        <button
                          type="button"
                          onClick={() => setSelectedMemberForPerms(isExpanded ? null : member)}
                          className={`p-1.5 rounded-lg border transition-colors ${
                            isExpanded
                              ? 'bg-primary text-white border-[var(--c-primary)]'
                              : 'text-app-faint hover:text-primary border-token  bg-app '
                          }`}
                          title="Granular permissions"
                         aria-label={`Permissions for ${member.name}`} aria-expanded={isExpanded} >
                          <Sliders className="w-3.5 h-3.5" />
                        </button>

                        {/* Kick Member Button */}
                        <button
                          type="button"
                          onClick={() => setKickTargetUser(member)}
                          className="px-2 py-1 bg-surface hover:bg-bubble-in   text-danger  border border-token  rounded-lg text-[10px] font-bold flex items-center gap-1 transition-colors active:scale-95"
                          title="Kick from group" aria-label="Kick from group"
                        >
                          <UserMinus className="w-3 h-3" />
                          <span>{lang === 'bn' ? 'কিক' : 'Kick'}</span>
                        </button>
                      </>
                    ) : (
                      // Display-only Badge
                      <span
                        className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                          currentRole === 'admin'
                            ? 'text-primary  bg-surface  border-token '
                            : currentRole === 'moderator'
                            ? 'text-primary  bg-surface  border-token '
                            : currentRole === 'controller'
                            ? 'text-primary  bg-surface  border-token '
                            : 'text-app-2 bg-bubble-in  border-token '
                        }`}
                      >
                        {currentRole === 'admin'
                          ? 'Admin'
                          : currentRole === 'moderator'
                          ? 'Moderator'
                          : currentRole === 'controller'
                          ? 'Controller'
                          : 'Member'}
                      </span>
                    )}

                    {/* Block / Report (Phase 0.11) */}
                    {!isMe && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            blockedIds.includes(member.id)
                              ? unblockUser(member.id)
                              : blockUser(member.id, member.name)
                          }
                          className="p-1.5 text-danger hover:text-danger border border-token  bg-surface  rounded-lg transition-colors"
                          title={
                            blockedIds.includes(member.id)
                              ? lang === 'bn'
                                ? 'আনব্লক করুন'
                                : 'Unblock user'
                              : lang === 'bn'
                              ? 'ব্লক করুন'
                              : 'Block user'
                          } aria-label={
                            blockedIds.includes(member.id)
                              ? lang === 'bn'
                                ? 'আনব্লক করুন'
                                : 'Unblock user'
                              : lang === 'bn'
                              ? 'ব্লক করুন'
                              : 'Block user'
                          }
                        >
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => reportUser(member.id, member.name)}
                          className="p-1.5 text-app-faint hover:text-danger border border-token  bg-app  rounded-lg transition-colors"
                          title={lang === 'bn' ? 'রিপোর্ট করুন' : 'Report user'} aria-label={lang === 'bn' ? 'রিপোর্ট করুন' : 'Report user'}
                        >
                          <Flag className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Inline Expandable Granular Permissions Panel */}
                {isExpanded && !isMe && (
                  <div className="mt-3 pt-3 border-t border-token  bg-bubble-in  p-3 rounded-xl space-y-2 animate-in fade-in text-xs">
                    <div className="flex items-center justify-between pb-1">
                      <span className="font-bold text-app  text-[11px]">
                        {lang === 'bn' ? `"${member.name}" এর জন্য পারমিশন:` : `Permissions for "${member.name}":`}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleApplyPreset(member.id, 'moderator')}
                          className="px-2 py-0.5 rounded text-[10px] font-bold bg-bubble-in text-primary hover:bg-bubble-in"
                        >
                          Preset: Full Mod
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApplyPreset(member.id, 'editor')}
                          className="px-2 py-0.5 rounded text-[10px] font-bold bg-bubble-in text-primary hover:bg-bubble-in"
                        >
                          Editor Only
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className="flex items-center justify-between p-2 rounded-lg bg-app  border border-token  cursor-pointer">
                        <span className="font-semibold text-app ">
                          {lang === 'bn' ? '✏️ সাবচ্যানেল এডিট' : '✏️ Edit Subchannels'}
                        </span>
                        <input
                          type="checkbox"
                          checked={perms.canEditSubchannel ?? false}
                          onChange={() => handleTogglePermission(member.id, 'canEditSubchannel')}
                          className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-2 rounded-lg bg-app  border border-token  cursor-pointer">
                        <span className="font-semibold text-app ">
                          {lang === 'bn' ? '🗑️ সাবচ্যানেল ডিলিট' : '🗑️ Delete Subchannels'}
                        </span>
                        <input
                          type="checkbox"
                          checked={perms.canDeleteSubchannel ?? false}
                          onChange={() => handleTogglePermission(member.id, 'canDeleteSubchannel')}
                          className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-2 rounded-lg bg-app  border border-token  cursor-pointer">
                        <span className="font-semibold text-app ">
                          {lang === 'bn' ? '➕ সাবচ্যানেল তৈরি' : '➕ Create Subchannels'}
                        </span>
                        <input
                          type="checkbox"
                          checked={perms.canCreateSubchannel ?? false}
                          onChange={() => handleTogglePermission(member.id, 'canCreateSubchannel')}
                          className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-2 rounded-lg bg-app  border border-token  cursor-pointer">
                        <span className="font-semibold text-app ">
                          {lang === 'bn' ? '🔒 লকড চ্যানেলে অ্যাক্সেস' : '🔒 Locked Channel Access'}
                        </span>
                        <input
                          type="checkbox"
                          checked={perms.canPostInLocked ?? false}
                          onChange={() => handleTogglePermission(member.id, 'canPostInLocked')}
                          className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Phase 1.5 Danger zone: Leave / Delete ── */}
      <div className="bg-app  mt-2 mb-10 border-y border-token  p-4 space-y-2">
        {!isOwner && (
          <button type="button" onClick={() => setShowLeaveConfirm(true)} className="w-full py-2.5 rounded-xl border border-token  bg-surface  text-danger  text-xs font-bold flex items-center justify-center gap-2">
            <LogOut className="w-4 h-4" /> {lang === 'bn' ? 'গ্রুপ ছাড়ুন' : 'Leave group'}
          </button>
        )}
        {isOwner && (
          <button type="button" onClick={() => { setDeleteConfirmText(''); setDeleteError(null); setShowDeleteConfirm(true); }} className="w-full py-2.5 rounded-xl bg-danger hover:brightness-110 text-white text-xs font-bold flex items-center justify-center gap-2">
            <Trash2 className="w-4 h-4" /> {lang === 'bn' ? 'গ্রুপ ডিলিট করুন' : 'Delete group'}
          </button>
        )}
        {isOwner && <p className="text-[11px] text-app-faint text-center">{lang === 'bn' ? 'মালিক হিসেবে গ্রুপ ছাড়তে হলে আগে মালিকানা হস্তান্তর করুন' : 'As owner you delete the group instead of leaving it'}</p>}
      </div>

      {/* ========================================================================= */}
      {/* 🛡️ 'ADMIN/MODERATOR' MANAGEMENT MODAL (User Requested!)                  */}
      {/* ========================================================================= */}
      {showAdminManagementModal && (
        <div className="fixed inset-0 z-50 bg-black/75  flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-xl p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'এডমিন ও মডারেটর ব্যবস্থাপনা' : 'Admin & Moderator Management'} >
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-token ">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-surface  text-primary  flex items-center justify-center">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-app ">
                    {lang === 'bn' ? 'এডমিন ও মডারেটর ব্যবস্থাপনা' : 'Admin & Moderator Management'}
                  </h3>
                  <p className="text-xs text-app-2 ">
                    {lang === 'bn'
                      ? 'মেম্বারদের ভূমিকা ও সাবচ্যানেল এডিট/ডিলিট পারমিশন প্রদান করুন'
                      : 'Assign roles & grant subchannel edit/delete permissions'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowAdminManagementModal(false);
                  setSelectedMemberForPerms(null);
                }}
                className="p-1.5 text-app-faint hover:text-app  rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Member Search inside Modal */}
            <div className="relative">
              <Search className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={managementSearch}
                onChange={(e) => setManagementSearch(e.target.value)}
                placeholder={lang === 'bn' ? 'মেম্বার খুঁজুন...' : 'Search members to manage...'} aria-label={lang === 'bn' ? 'মেম্বার খুঁজুন...' : 'Search members to manage...'}
                className="w-full bg-surface  border border-token  rounded-xl pl-9 pr-4 py-2 text-xs text-app    "
              />
            </div>

            {/* Member List with Granular Permission Editors */}
            <div className="space-y-3">
              {filteredMembers
                .filter((m) => m.name.toLowerCase().includes(managementSearch.toLowerCase()))
                .map((member) => {
                  const isMe = member.id === currentUser.id;
                  const currentRole: GroupRole =
                    (channel.memberRoles && channel.memberRoles[member.id]) ||
                    (member.isAdmin || member.role === 'admin' ? 'admin' : member.role === 'Moderator' ? 'moderator' : 'member');
                  const perms = getMemberPermissions(member.id, currentRole);
                  const isExpanded = selectedMemberForPerms?.id === member.id;

                  return (
                    <div
                      key={member.id}
                      className="p-3.5 rounded-2xl bg-surface  border border-token  space-y-3 transition-colors"
                    >
                      {/* Member Overview Row */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={member.avatar}
                            alt={member.name}
                            className="w-10 h-10 rounded-full object-cover shrink-0"
                          />
                          <div className="min-w-0">
                            <h4 className="text-xs sm:text-sm font-bold text-app truncate bn-safe bn-text">
                              {member.name} {isMe && <span className="text-app-faint font-normal">({lang === 'bn' ? 'আপনি' : 'You'})</span>}
                            </h4>
                            <p className="text-[11px] text-app-faint truncate">
                              {member.email || member.status || 'Active Member'}
                            </p>
                          </div>
                        </div>

                        {/* Role Selector */}
                        <div className="flex items-center gap-2 shrink-0">
                          {!isMe ? (
                            <select
                              value={currentRole}
                              onChange={(e) => handleRoleChange(member.id, e.target.value as GroupRole)}
                              className="text-xs font-bold py-1.5 px-2.5 rounded-xl bg-app  text-app  border border-token     cursor-pointer"
                             aria-label={`Role for ${member.name}`} >
                              <option value="admin">{lang === 'bn' ? 'এডমিন (Admin)' : 'Admin'}</option>
                              <option value="moderator">{lang === 'bn' ? 'মডারেটর (Moderator)' : 'Moderator'}</option>
                              <option value="controller">{lang === 'bn' ? 'কন্ট্রোলার (Controller)' : 'Controller'}</option>
                              <option value="member">{lang === 'bn' ? 'মেম্বার (Member)' : 'Member'}</option>
                            </select>
                          ) : (
                            <span className="text-xs font-bold px-2.5 py-1 rounded-xl bg-primary text-white">
                              Admin (You)
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() =>
                              setSelectedMemberForPerms(isExpanded ? null : member)
                            }
                            className={`p-1.5 rounded-lg border transition-colors ${
                              isExpanded
                                ? 'bg-primary text-white border-[var(--c-primary)]'
                                : 'text-app-faint hover:text-primary border-token  bg-app '
                            }`}
                            title="Toggle granular permissions"
                           aria-label={`Permissions for ${member.name}`} aria-expanded={isExpanded} >
                            <Sliders className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {/* Granular Permission Toggles (User Requested: specific permissions for editing and deleting subchannels) */}
                      {(isExpanded || currentRole === 'moderator' || currentRole === 'controller') && !isMe && (
                        <div className="pt-2 border-t border-token  space-y-2 text-xs animate-in fade-in">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-bold text-app-2  uppercase tracking-wider">
                              {lang === 'bn' ? 'সাবচ্যানেল ও রোল পারমিশন:' : 'Subchannel & Role Permissions:'}
                            </p>

                            {/* Preset Buttons */}
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleApplyPreset(member.id, 'moderator')}
                                className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-bubble-in  text-primary  hover:bg-bubble-in"
                              >
                                Full Mod
                              </button>
                              <button
                                type="button"
                                onClick={() => handleApplyPreset(member.id, 'editor')}
                                className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-bubble-in  text-primary  hover:bg-bubble-in"
                              >
                                Editor Only
                              </button>
                              <button
                                type="button"
                                onClick={() => handleApplyPreset(member.id, 'member')}
                                className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-pressed  text-app  hover:bg-pressed"
                              >
                                Reset
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {/* 1. Edit Subchannel Permission */}
                            <label className="flex items-center justify-between p-2 rounded-xl bg-app  border border-token  cursor-pointer">
                              <div className="pr-2">
                                <span className="font-semibold block text-app  text-xs">
                                  {lang === 'bn' ? '✏️ সাবচ্যানেল এডিট' : '✏️ Edit Subchannels'}
                                </span>
                                <span className="text-[10px] text-app-faint block">
                                  {lang === 'bn' ? 'নাম, বিবরণ ও প্রাইভেসি পরিবর্তন' : 'Rename & edit topics'}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={perms.canEditSubchannel ?? false}
                                onChange={() => handleTogglePermission(member.id, 'canEditSubchannel')}
                                className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                              />
                            </label>

                            {/* 2. Delete Subchannel Permission */}
                            <label className="flex items-center justify-between p-2 rounded-xl bg-app  border border-token  cursor-pointer">
                              <div className="pr-2">
                                <span className="font-semibold block text-app  text-xs">
                                  {lang === 'bn' ? '🗑️ সাবচ্যানেল ডিলিট' : '🗑️ Delete Subchannels'}
                                </span>
                                <span className="text-[10px] text-app-faint block">
                                  {lang === 'bn' ? 'সাবচ্যানেল মুছে ফেলার অনুমতি' : 'Delete/remove subchannels'}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={perms.canDeleteSubchannel ?? false}
                                onChange={() => handleTogglePermission(member.id, 'canDeleteSubchannel')}
                                className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                              />
                            </label>

                            {/* 3. Create Subchannel Permission */}
                            <label className="flex items-center justify-between p-2 rounded-xl bg-app  border border-token  cursor-pointer">
                              <div className="pr-2">
                                <span className="font-semibold block text-app  text-xs">
                                  {lang === 'bn' ? '➕ সাবচ্যানেল তৈরি' : '➕ Create Subchannels'}
                                </span>
                                <span className="text-[10px] text-app-faint block">
                                  {lang === 'bn' ? 'নতুন হ্যাশট্যাগ চ্যানেল যোগ' : 'Add new #sections'}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={perms.canCreateSubchannel ?? false}
                                onChange={() => handleTogglePermission(member.id, 'canCreateSubchannel')}
                                className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                              />
                            </label>

                            {/* 4. Post in Locked Channels */}
                            <label className="flex items-center justify-between p-2 rounded-xl bg-app  border border-token  cursor-pointer">
                              <div className="pr-2">
                                <span className="font-semibold block text-app  text-xs">
                                  {lang === 'bn' ? '🔒 লকড চ্যানেলে অ্যাক্সেস' : '🔒 Locked Channels'}
                                </span>
                                <span className="text-[10px] text-app-faint block">
                                  {lang === 'bn' ? 'প্রাইভেট চ্যানেলে চ্যাট' : 'Access private channels'}
                                </span>
                              </div>
                              <input
                                type="checkbox"
                                checked={perms.canPostInLocked ?? false}
                                onChange={() => handleTogglePermission(member.id, 'canPostInLocked')}
                                className="w-4 h-4 accent-(--c-primary) rounded cursor-pointer"
                              />
                            </label>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>

            {/* Modal Footer */}
            <div className="pt-3 border-t border-token  flex items-center justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowAdminManagementModal(false);
                  setSelectedMemberForPerms(null);
                }}
                className="px-5 py-2.5 bg-primary hover:brightness-110 text-white rounded-xl text-xs font-bold shadow-md  transition-colors active:scale-[0.99]"
              >
                {lang === 'bn' ? 'সংরক্ষণ ও সম্পন্ন' : 'Save & Done'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ✏️ EDIT SUBCHANNEL MODAL (User Requested: Fix subchannel management)      */}
      {/* ========================================================================= */}
      {editingSubchannel && (
        <div className="fixed inset-0 z-50 bg-black/75  flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 shadow-2xl space-y-4 transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সাবচ্যানেল এডিট করুন' : 'Edit Sub-channel'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-bubble-in  text-primary  flex items-center justify-center">
                  <Edit2 className="w-4 h-4" />
                </div>
                <h3 className="text-base font-bold text-app ">
                  {lang === 'bn' ? 'সাবচ্যানেল এডিট করুন' : 'Edit Sub-channel'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingSubchannel(null)}
                className="p-1 text-app-faint hover:text-app  rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEditSubchannel} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-app  mb-1">
                  {lang === 'bn' ? 'সাবচ্যানেলের নাম (#)' : 'Subchannel Name (#)'}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-app-faint font-bold">#</span>
                  <input
                    type="text"
                    value={editSecName}
                    onChange={(e) => setEditSecName(e.target.value)}
                    required
                    className="w-full bg-surface  border border-token  rounded-xl pl-8 pr-4 py-2.5 text-xs text-app  font-medium   "
                   aria-label={lang === 'bn' ? 'সাবচ্যানেলের নাম (#)' : 'Subchannel Name (#)'} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-app  mb-1">
                  {lang === 'bn' ? 'বিবরণ বা টপিক' : 'Description / Topic'}
                </label>
                <input
                  type="text"
                  value={editSecDescription}
                  onChange={(e) => setEditSecDescription(e.target.value)}
                  placeholder={lang === 'bn' ? 'এই সাবচ্যানেলের মূল বিষয়...' : 'What is this channel for?'}
                  className="w-full bg-surface  border border-token  rounded-xl px-3 py-2 text-xs text-app    "
                 aria-label={lang === 'bn' ? 'বিবরণ বা টপিক' : 'Description / Topic'} />
              </div>

              {/* Private / Locked Toggle */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-surface  border border-token ">
                <div className="flex items-center gap-2">
                  <Lock className={`w-4 h-4 ${editSecIsPrivate ? 'text-away' : 'text-app-faint'}`} />
                  <div>
                    <span className="text-xs font-bold text-app  block">
                      {lang === 'bn' ? 'প্রাইভেট বা লকড চ্যানেল' : 'Private / Locked Channel'}
                    </span>
                    <span className="text-[10px] text-app-faint block">
                      {lang === 'bn' ? 'কেবল এডমিন ও অনুমতিপ্রাপ্ত মডারেটর প্রবেশ করতে পারবে' : 'Only Admins & authorized members can view and chat'}
                    </span>
                  </div>
                </div>

                <input
                  type="checkbox"
                  checked={editSecIsPrivate}
                  onChange={(e) => setEditSecIsPrivate(e.target.checked)}
                  className="w-5 h-5 accent-(--c-primary) rounded cursor-pointer"
                 aria-label={lang === 'bn' ? 'প্রাইভেট বা লকড চ্যানেল' : 'Private / Locked Channel'} />
              </div>

              {/* Read-only / Announcements Toggle (Phase 1.5) */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-surface  border border-token ">
                <div className="flex items-center gap-2">
                  <Megaphone className={`w-4 h-4 ${editSecReadOnly ? 'text-primary' : 'text-app-faint'}`} />
                  <div>
                    <span className="text-xs font-bold text-app  block">
                      {lang === 'bn' ? 'রিড-অনলি (ঘোষণা)' : 'Read-only (announcements)'}
                    </span>
                    <span className="text-[10px] text-app-faint block">
                      {lang === 'bn' ? 'কেবল মালিক ও এডমিন পোস্ট করতে পারবে' : 'Only owner & admins can post'}
                    </span>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={editSecReadOnly}
                  onChange={(e) => setEditSecReadOnly(e.target.checked)}
                  className="w-5 h-5 accent-(--c-primary) rounded cursor-pointer"
                 aria-label={lang === 'bn' ? 'রিড-অনলি (ঘোষণা)' : 'Read-only (announcements)'} />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-token ">
                <button
                  type="button"
                  onClick={() => setEditingSubchannel(null)}
                  className="px-4 py-2 text-xs text-app-2 hover:text-app "
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-primary hover:brightness-110 text-white rounded-xl text-xs font-bold shadow-md  transition-colors active:scale-[0.99]"
                >
                  {lang === 'bn' ? 'আপডেট করুন' : 'Update Subchannel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 🗑️ DELETE SUBCHANNEL CONFIRMATION MODAL (User Requested: UX Writer Delete) */}
      {/* ========================================================================= */}
      {deletingSubchannel && (
        <div className="fixed inset-0 z-50 bg-black/75  flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-6 shadow-2xl space-y-4 text-center transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সাবচ্যানেলটি ডিলিট করবেন?' : 'Delete Subchannel?'} >
            <div className="w-14 h-14 mx-auto rounded-2xl bg-surface  text-danger  flex items-center justify-center shadow-inner">
              <Trash2 className="w-7 h-7" />
            </div>

            <div>
              <h3 className="text-base font-bold text-app ">
                {lang === 'bn' ? 'সাবচ্যানেলটি ডিলিট করবেন?' : 'Delete Subchannel?'}
              </h3>
              <p className="text-xs text-app-2  mt-1">
                {lang === 'bn'
                  ? `আপনি কি নিশ্চিতভাবে "#${deletingSubchannel.name}" সাবচ্যানেলটি মুছে ফেলতে চান? এর অন্তর্ভুক্ত মেসেজগুলো আর দেখা যাবে না।`
                  : `Are you sure you want to delete the subchannel "#${deletingSubchannel.name}"? This action cannot be undone.`}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeletingSubchannel(null)}
                className="flex-1 py-2.5 bg-bubble-in  text-app  rounded-xl text-xs font-semibold hover:bg-pressed transition-colors"
              >
                {lang === 'bn' ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSubchannel}
                className="flex-1 py-2.5 bg-danger hover:brightness-110 text-white rounded-xl text-xs font-bold shadow-md  transition-colors"
              >
                {lang === 'bn' ? 'ডিলিট করুন' : 'Delete Subchannel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ➕ ADD NEW SUBCHANNEL MODAL                                               */}
      {/* ========================================================================= */}
      {showAddSubchannelModal && (
        <div className="fixed inset-0 z-50 bg-black/75  flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 shadow-2xl space-y-4 transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'নতুন সাবচ্যানেল তৈরি করুন' : 'Create New Sub-channel'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-bubble-in  text-primary  flex items-center justify-center">
                  <Plus className="w-4 h-4" />
                </div>
                <h3 className="text-base font-bold text-app ">
                  {lang === 'bn' ? 'নতুন সাবচ্যানেল তৈরি করুন' : 'Create New Sub-channel'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAddSubchannelModal(false)}
                className="p-1 text-app-faint hover:text-app  rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSubchannel} className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-app  mb-1">
                  {lang === 'bn' ? 'সাবচ্যানেলের নাম (#)' : 'Subchannel Name (#)'}
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-app-faint font-bold">#</span>
                  <input
                    type="text"
                    value={newSecName}
                    onChange={(e) => setNewSecName(e.target.value)}
                    placeholder="e.g. ux-writers, marketing, sprint-review"
                    required
                    className="w-full bg-surface  border border-token  rounded-xl pl-8 pr-4 py-2.5 text-xs text-app  font-medium   "
                   aria-label={lang === 'bn' ? 'সাবচ্যানেলের নাম (#)' : 'Subchannel Name (#)'} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-app  mb-1">
                  {lang === 'bn' ? 'বিবরণ বা টপিক' : 'Description / Purpose'}
                </label>
                <input
                  type="text"
                  value={newSecDescription}
                  onChange={(e) => setNewSecDescription(e.target.value)}
                  placeholder={lang === 'bn' ? 'এই সাবচ্যানেলের মূল বিষয়...' : 'What is this channel for?'}
                  className="w-full bg-surface  border border-token  rounded-xl px-3 py-2 text-xs text-app    "
                 aria-label={lang === 'bn' ? 'বিবরণ বা টপিক' : 'Description / Purpose'} />
              </div>

              {/* Private / Locked Toggle */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-surface  border border-token ">
                <div className="flex items-center gap-2">
                  <Lock className={`w-4 h-4 ${newSecIsPrivate ? 'text-away' : 'text-app-faint'}`} />
                  <div>
                    <span className="text-xs font-bold text-app  block">
                      {lang === 'bn' ? 'প্রাইভেট বা লকড চ্যানেল' : 'Private / Locked Channel'}
                    </span>
                    <span className="text-[10px] text-app-faint block">
                      {lang === 'bn' ? 'কেবল এডমিন ও অনুমতিপ্রাপ্ত মডারেটর প্রবেশ করতে পারবে' : 'Only Admins & authorized members can view and chat'}
                    </span>
                  </div>
                </div>

                <input
                  type="checkbox"
                  checked={newSecIsPrivate}
                  onChange={(e) => setNewSecIsPrivate(e.target.checked)}
                  className="w-5 h-5 accent-(--c-primary) rounded cursor-pointer"
                 aria-label={lang === 'bn' ? 'প্রাইভেট বা লকড চ্যানেল' : 'Private / Locked Channel'} />
              </div>

              {/* Read-only / Announcements Toggle (Phase 1.5) */}
              <div className="flex items-center justify-between p-3 rounded-2xl bg-surface  border border-token ">
                <div className="flex items-center gap-2">
                  <Megaphone className={`w-4 h-4 ${newSecReadOnly ? 'text-primary' : 'text-app-faint'}`} />
                  <div>
                    <span className="text-xs font-bold text-app  block">
                      {lang === 'bn' ? 'রিড-অনলি (ঘোষণা)' : 'Read-only (announcements)'}
                    </span>
                    <span className="text-[10px] text-app-faint block">
                      {lang === 'bn' ? 'কেবল মালিক ও এডমিন পোস্ট করতে পারবে' : 'Only owner & admins can post'}
                    </span>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={newSecReadOnly}
                  onChange={(e) => setNewSecReadOnly(e.target.checked)}
                  className="w-5 h-5 accent-(--c-primary) rounded cursor-pointer"
                 aria-label={lang === 'bn' ? 'রিড-অনলি (ঘোষণা)' : 'Read-only (announcements)'} />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-token ">
                <button
                  type="button"
                  onClick={() => setShowAddSubchannelModal(false)}
                  className="px-4 py-2 text-xs text-app-2 hover:text-app "
                >
                  {lang === 'bn' ? 'বাতিল' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-primary hover:brightness-110 text-white rounded-xl text-xs font-bold shadow-md  transition-colors active:scale-[0.99]"
                >
                  {lang === 'bn' ? 'তৈরি করুন' : 'Create Subchannel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Phase 1.5: ADD MEMBER MODAL (by user ID) ── */}
      {showAddMemberModal && (
        <div className="fixed inset-0 z-50 bg-black/75  flex items-center justify-center p-4 animate-in fade-in select-none">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'সদস্য যোগ করুন' : 'Add member'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <h3 className="text-base font-bold text-app  flex items-center gap-2"><UserPlus className="w-5 h-5 text-primary" />{lang === 'bn' ? 'সদস্য যোগ করুন' : 'Add member'}</h3>
              <button type="button" onClick={() => setShowAddMemberModal(false)} className="p-1 text-app-faint hover:text-app rounded-lg" aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} ><X className="w-5 h-5" /></button>
            </div>
            <div className="relative">
              <Search className="w-4 h-4 text-app-faint absolute left-3 top-1/2 -translate-y-1/2" />
              <input type="text" value={addMemberSearch} onChange={(e) => setAddMemberSearch(e.target.value)} placeholder={lang === 'bn' ? 'ব্যবহারকারী খুঁজুন…' : 'Search people…'} aria-label={lang === 'bn' ? 'ব্যবহারকারী খুঁজুন…' : 'Search people…'} className="w-full bg-surface  border border-token  rounded-xl pl-9 pr-4 py-2 text-xs " />
            </div>
            <div className="space-y-2">
              {users.filter((u) => !memberIdList.includes(u.id)).filter((u) => u.name.toLowerCase().includes(addMemberSearch.toLowerCase()) || (u.username || '').toLowerCase().includes(addMemberSearch.toLowerCase())).map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-surface  border border-token ">
                  <div className="flex items-center gap-2 min-w-0">
                    <img src={u.avatar} alt={u.name} className="w-9 h-9 rounded-full object-cover shrink-0" />
                    <div className="min-w-0"><p className="text-xs font-bold truncate">{u.name}</p>{u.username && <p className="text-[10px] text-app-faint truncate">@{u.username}</p>}</div>
                  </div>
                  <button type="button" onClick={() => handleAddMemberById(u.id)} className="px-3 py-1.5 bg-primary text-white rounded-lg text-[11px] font-bold shrink-0">{lang === 'bn' ? 'যোগ করুন' : 'Add'}</button>
                </div>
              ))}
              {users.filter((u) => !memberIdList.includes(u.id)).length === 0 && <p className="text-xs text-app-2 text-center py-3">{lang === 'bn' ? 'সবাই ইতিমধ্যে সদস্য' : 'Everyone is already a member'}</p>}
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 1.5: LEAVE GROUP CONFIRM ── */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70  flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-6 shadow-2xl space-y-4 text-center transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'গ্রুপ ছাড়বেন?' : 'Leave group?'} >
            <div className="w-14 h-14 mx-auto rounded-2xl bg-surface  text-danger flex items-center justify-center"><LogOut className="w-7 h-7" /></div>
            <div><h3 className="text-base font-bold">{lang === 'bn' ? 'গ্রুপ ছাড়বেন?' : 'Leave group?'}</h3><p className="text-xs text-app-2 mt-1">{lang === 'bn' ? `আপনি "${channel.name}" ছেড়ে যাবেন। আবার যোগ দিতে ইনভাইট লাগবে।` : `You will leave "${channel.name}". You will need a new invite to rejoin.`}</p></div>
            <div className="flex gap-2"><button type="button" onClick={() => setShowLeaveConfirm(false)} className="flex-1 py-2.5 bg-bubble-in  rounded-xl text-xs font-semibold">{lang === 'bn' ? 'বাতিল' : 'Cancel'}</button><button type="button" onClick={handleLeaveGroup} className="flex-1 py-2.5 bg-danger text-white rounded-xl text-xs font-bold">{lang === 'bn' ? 'ছাড়ুন' : 'Leave'}</button></div>
          </div>
        </div>
      )}

      {/* ── Phase 1.5: DELETE GROUP (type-to-confirm, owner only) ── */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70  flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-6 shadow-2xl space-y-4 transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'গ্রুপ ডিলিট করবেন?' : 'Delete group?'} >
            <div className="text-center"><div className="w-14 h-14 mx-auto rounded-2xl bg-surface  text-danger flex items-center justify-center"><Trash2 className="w-7 h-7" /></div>
            <h3 className="text-base font-bold mt-3">{lang === 'bn' ? 'গ্রুপ ডিলিট করবেন?' : 'Delete group?'}</h3>
            <p className="text-xs text-app-2 mt-1">{lang === 'bn' ? 'এটি স্থায়ী — সব মেসেজ মুছে যাবে। নিশ্চিত করতে গ্রুপের নাম লিখুন:' : 'This is permanent — the group and its messages will be deleted. Type the group name to confirm:'} <strong>{channel.name}</strong></p></div>
            <input type="text" value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} placeholder={channel.name} className="w-full p-2.5 bg-surface  border border-token  rounded-xl text-xs"  aria-label={lang === 'bn' ? 'নিশ্চিত করতে গ্রুপের নাম লিখুন' : 'Type the group name to confirm deletion'} />
            {deleteError && <p className="text-[11px] text-danger">{deleteError}</p>}
            <div className="flex gap-2"><button type="button" onClick={() => setShowDeleteConfirm(false)} className="flex-1 py-2.5 bg-bubble-in  rounded-xl text-xs font-semibold">{lang === 'bn' ? 'বাতিল' : 'Cancel'}</button><button type="button" disabled={deleteBusy || deleteConfirmText.trim() !== channel.name} onClick={handleDeleteGroup} className="flex-1 py-2.5 bg-danger text-white rounded-xl text-xs font-bold disabled:opacity-40">{deleteBusy ? '…' : (lang === 'bn' ? 'ডিলিট করুন' : 'Delete group')}</button></div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* KICK MEMBER CONFIRMATION MODAL                                            */}
      {/* ========================================================================= */}
      {kickTargetUser && (
        <div className="fixed inset-0 z-50 bg-black/70  flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-sm p-6 shadow-2xl space-y-4 text-center transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'মেম্বারকে কিক করবেন?' : 'Kick Member from Group?'} >
            <div className="w-14 h-14 mx-auto rounded-2xl bg-surface  text-danger  flex items-center justify-center shadow-inner">
              <UserMinus className="w-7 h-7" />
            </div>

            <div>
              <h3 className="text-base font-bold text-app ">
                {lang === 'bn' ? 'মেম্বারকে কিক করবেন?' : 'Kick Member from Group?'}
              </h3>
              <p className="text-xs text-app-2  mt-1">
                {lang === 'bn'
                  ? `আপনি কি নিশ্চিতভাবে "${kickTargetUser.name}" কে "${channel.name}" গ্রুপ থেকে বের (Kick) করে দিতে চান?`
                  : `Are you sure you want to kick "${kickTargetUser.name}" from "${channel.name}"?`}
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setKickTargetUser(null)}
                className="flex-1 py-2.5 bg-bubble-in  text-app  rounded-xl text-xs font-semibold hover:bg-pressed transition-colors"
              >
                {lang === 'bn' ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={confirmKickMember}
                className="flex-1 py-2.5 bg-danger hover:brightness-110 text-white rounded-xl text-xs font-bold shadow-md  transition-colors"
              >
                {lang === 'bn' ? 'কিক করুন (Kick)' : 'Kick Member'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* CHANGE GROUP IMAGE MODAL                                                  */}
      {/* ========================================================================= */}
      {showImageModal && (
        <div className="fixed inset-0 z-50 bg-black/70  flex items-center justify-center p-4 animate-in fade-in">
          <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 shadow-2xl space-y-4 transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'গ্রুপের ছবি পরিবর্তন করুন' : 'Change Group Photo'} >
            <div className="flex items-center justify-between pb-2 border-b border-token ">
              <h3 className="text-base font-bold text-app  flex items-center gap-2">
                <Camera className="w-5 h-5 text-primary" />
                <span>{lang === 'bn' ? 'গ্রুপের ছবি পরিবর্তন করুন' : 'Change Group Photo'}</span>
              </h3>
              <button
                onClick={() => setShowImageModal(false)}
                className="p-1 text-app-faint hover:text-app  rounded-lg"
               aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-3 bg-surface  border border-token  text-primary  hover:bg-bubble-in rounded-2xl text-xs font-bold flex items-center justify-center gap-2 transition-colors shadow-xs"
              >
                <Camera className="w-4 h-4" />
                <span>{lang === 'bn' ? 'ডিভাইস থেকে নতুন ছবি আপলোড করুন' : 'Upload Image from Device'}</span>
              </button>
            </div>

            <div>
              <p className="text-xs font-semibold text-app-2  mb-2">
                {lang === 'bn' ? 'অথবা নিচের ছবিগুলো থেকে নির্বাচন করুন:' : 'Or choose from presets:'}
              </p>
              <div className="grid grid-cols-5 gap-2">
                {CURATED_GROUP_AVATARS.map((url, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleSelectCuratedAvatar(url)}
                    className="aspect-square rounded-xl overflow-hidden cursor-pointer ring-2 ring-transparent hover:ring-(--c-primary) hover:scale-105 transition-colors shadow-xs"
                  >
                    <img src={url} alt="Cover option" className="w-full h-full object-cover" />
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-2 text-right">
              <button
                type="button"
                onClick={() => setShowImageModal(false)}
                className="px-4 py-2 text-xs font-semibold text-app-2 hover:text-app "
              >
                {lang === 'bn' ? 'বন্ধ করুন' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 👤 OTHER-USER PROFILE CARD (member-row tap)                               */}
      {/* ========================================================================= */}
      {profileTarget && profileTarget.id !== currentUser.id && (
        <ProfileCard
          user={toProfileCardUser(profileTarget)}
          lang={lang}
          onClose={() => setProfileTarget(null)}
          onMessage={() => {
            const u = profileTarget;
            setProfileTarget(null);
            // Existing DM-open behaviour (App's handleSelectChat via
            // onSelectMember) — now reached from the card, not the row.
            onSelectMember(u);
          }}
          onCall={() => {
            const u = profileTarget;
            setProfileTarget(null);
            // Only a real handler passed by the host starts a call; with no
            // onCallMember wired the tap just dismisses the card (no fake
            // call UI). See the wiring note on the prop.
            if (onCallMember) onCallMember(u);
          }}
          onBlock={
            blockedIds.includes(profileTarget.id)
              ? undefined
              : () => {
                  const u = profileTarget;
                  setProfileTarget(null);
                  // Existing Phase 0.11 block flow (confirm + POST /api/blocks).
                  blockUser(u.id, u.name);
                }
          }
          sharedMediaCount={sharedMediaCountFor(profileTarget.id)}
          onOpenSharedMedia={() => {
            setProfileTarget(null);
            setActiveMediaTab('images');
          }}
        />
      )}
    </div>
  );
};
