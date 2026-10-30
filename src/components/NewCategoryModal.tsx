import React, { useState } from 'react';
import { X, Check, Search, Users } from 'lucide-react';
import { User } from '../types/chat';

interface NewCategoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  users: User[];
  onCreateCategory: (name: string, memberNames: string[], tags: string[]) => void;
  lang: 'bn' | 'en';
}

const AVAILABLE_TAGS = ['Personal chats', 'Groups', 'Organizations', 'Friends', 'Work & Project'];

export const NewCategoryModal: React.FC<NewCategoryModalProps> = ({
  isOpen,
  onClose,
  users,
  onCreateCategory,
  lang,
}) => {
  const [categoryName, setCategoryName] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>(['Groups']);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [searchMember, setSearchMember] = useState('');

  if (!isOpen) return null;

  // Toggle Tag on and off
  const handleToggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  // Toggle member selection
  const handleToggleMember = (userId: string) => {
    setSelectedMemberIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const filteredUsers = users.filter((u) =>
    u.name.toLowerCase().includes(searchMember.toLowerCase())
  );

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = categoryName.trim() || 'New Group';
    const chosenMemberNames = users
      .filter((u) => selectedMemberIds.includes(u.id))
      .map((u) => u.name);

    onCreateCategory(finalName, chosenMemberNames, selectedTags);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60  flex items-center justify-center p-4 animate-in fade-in select-none">
      <div className="glass-sheet rounded-[var(--r-sheet)] w-full max-w-md p-6 shadow-2xl relative max-h-[90vh] flex flex-col text-app  transition-[opacity,transform] [transition-duration:var(--dur-sheet)] [transition-timing-function:var(--ease-spring)]" role="dialog" aria-modal="true" aria-label={lang === 'bn' ? 'নতুন ক্যাটাগরি বা গ্রুপ' : 'Create New Category or Group'} >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-token ">
          <div className="flex items-center gap-2">
            <Users className="w-5 h-5 text-primary " />
            <h2 className="text-base font-bold">
              {lang === 'bn' ? 'নতুন ক্যাটাগরি বা গ্রুপ' : 'Create New Category or Group'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-app-faint hover:text-app rounded-lg transition-colors"
           aria-label={lang === 'bn' ? 'বন্ধ করুন' : 'Close'} >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleCreate} className="space-y-4 pt-3 flex-1 flex flex-col overflow-hidden">
          {/* Group / Category Name Input */}
          <div>
            <label className="block text-xs font-semibold text-app  mb-1">
              {lang === 'bn' ? 'ক্যাটাগরি বা গ্রুপের নাম' : 'Category / Group Name'}
            </label>
            <div className="flex items-center gap-2 border border-token  rounded-xl px-3 py-2 bg-surface   ">
              <input
                type="text"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder="e.g. Design Team, Family, Workmates..."
                className="flex-1 bg-transparent text-xs sm:text-sm font-semibold text-app  "
                autoFocus
                required
               aria-label={lang === 'bn' ? 'ক্যাটাগরি বা গ্রুপের নাম' : 'Category / Group Name'} />
            </div>
          </div>

          {/* Toggleable Suggested Tags */}
          <div>
            <p className="text-[11px] font-semibold text-app-faint mb-1.5">
              {lang === 'bn' ? 'প্রস্তাবিত ট্যাগ (ক্লিক করে সিলেক্ট/আনসিলেক্ট করুন):' : 'Suggested Tags (Click to select/unselect):'}
            </p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {AVAILABLE_TAGS.map((tag) => {
                const isSelected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => handleToggleTag(tag)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      isSelected
                        ? 'bg-[#0B6E4F] text-white shadow-xs'
                        : 'bg-bubble-in  text-app-2  hover:bg-pressed '
                    }`}
                   aria-pressed={isSelected} >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Member Picker List with checkboxes */}
          <div className="flex-1 flex flex-col min-h-0 pt-2 border-t border-token ">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-app ">
                {lang === 'bn' ? 'মেম্বার সিলেক্ট করুন' : 'Select Members'} ({selectedMemberIds.length} chosen)
              </span>
              <span className="text-[11px] text-primary  font-medium">
                {users.length} available
              </span>
            </div>

            {/* Search filter for members */}
            <div className="relative mb-2 shrink-0">
              <Search className="w-3.5 h-3.5 text-app-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchMember}
                onChange={(e) => setSearchMember(e.target.value)}
                placeholder={lang === 'bn' ? 'নাম দিয়ে খুঁজুন...' : 'Search people...'} aria-label={lang === 'bn' ? 'নাম দিয়ে খুঁজুন...' : 'Search people...'}
                className="w-full bg-surface  border border-token  rounded-lg pl-8 pr-3 py-1.5 text-xs "
              />
            </div>

            {/* Scrollable list of members with selection checkboxes */}
            {filteredUsers.length === 0 && (
              <div className="rounded-[var(--r-card)] border border-dashed border-token bg-surface px-4 py-6 text-center space-y-2 shrink-0">
                <Users className="w-8 h-8 mx-auto text-app-faint" />
                <p className="text-xs text-app-2">
                  {lang === 'bn' ? 'কোনো সদস্য পাওয়া যায়নি' : 'No people found'}
                </p>
              </div>
            )}
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 divide-y divide-[var(--c-border)] ">
              {filteredUsers.map((u) => {
                const isChecked = selectedMemberIds.includes(u.id);

                return (
                  <div
                    key={u.id}
                    onClick={() => handleToggleMember(u.id)}
                    className={`flex items-center justify-between p-2 rounded-xl cursor-pointer transition-colors ${
                      isChecked
                        ? 'bg-surface  text-primary '
                        : 'hover:bg-surface  text-app '
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={u.avatar}
                        alt={u.name}
                        className="w-8 h-8 rounded-full object-cover shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-bold truncate bn-safe bn-text">{u.name}</p>
                        <p className="text-[10px] text-app-faint truncate">{u.status}</p>
                      </div>
                    </div>

                    <div
                      className={`w-5 h-5 rounded-md flex items-center justify-center border transition-colors ${
                        isChecked
                          ? 'bg-[#0B6E4F] border-[#0B6E4F] text-white'
                          : 'border-token '
                      }`}
                    >
                      {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Submit Action */}
          <div className="pt-2 border-t border-token  flex justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-app-2 hover:text-app  rounded-xl"
            >
              {lang === 'bn' ? 'বাতিল' : 'Cancel'}
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-[#0B6E4F] hover:bg-[#095C42] text-white rounded-xl text-xs font-bold shadow-md  transition-colors"
            >
              {lang === 'bn' ? 'গ্রুপ তৈরি করুন' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
