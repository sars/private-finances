// The screens, grouped the way the sidebar, the phone tab bar and the command
// menu all present them. One list, three surfaces.
import {
  Activity,
  ArrowLeftRight,
  Banknote,
  ChartNoAxesCombined,
  Coins,
  DatabaseZap,
  FileText,
  Landmark,
  LayoutDashboard,
  ListChecks,
  PiggyBank,
  Receipt,
  Settings,
  Tags,
  Gem,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type Screen = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown only to an administrator. */
  admin?: boolean;
};
export type ScreenGroup = { label: string; items: Screen[] };

export const screenGroups: ScreenGroup[] = [
  {
    label: 'Money',
    items: [
      { href: '/', label: 'Home', icon: LayoutDashboard },
      { href: '/balances', label: 'Balances', icon: PiggyBank },
      {
        href: '/analytics',
        label: 'Spending analytics',
        icon: ChartNoAxesCombined,
      },
      { href: '/review', label: 'Review', icon: ListChecks },
      { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
      { href: '/receipts', label: 'Receipts', icon: Receipt },
      { href: '/cash', label: 'Cash', icon: Banknote },
      { href: '/assets', label: 'Assets', icon: Gem },
    ],
  },
  {
    label: 'Setup',
    items: [
      { href: '/categories', label: 'Categories & rules', icon: Tags },
      { href: '/accounts', label: 'Accounts & exclusions', icon: Wallet },
      { href: '/connections', label: 'Bank connections', icon: Landmark },
      { href: '/fx', label: 'Conversion status', icon: Coins },
      { href: '/settings', label: 'Settings', icon: Settings, admin: true },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/reports', label: 'Reports', icon: FileText },
      { href: '/imports', label: 'Bank imports', icon: DatabaseZap },
      { href: '/ops', label: 'System health', icon: Activity },
    ],
  },
];

/**
 * The four screens on the phone's tab bar; the fifth tab opens everything.
 *
 * Named rather than taken off the front of the Money group, so that adding a
 * screen to the sidebar cannot silently reorder the four buttons under
 * somebody's thumb. Changing the tab bar is its own decision, made here.
 */
export const tabScreens = ['/', '/analytics', '/review', '/transactions']
  .map((href) => screenGroups[0]!.items.find((item) => item.href === href)!)
  .filter(Boolean);

export function visibleGroups(isAdmin: boolean): ScreenGroup[] {
  return screenGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.admin || isAdmin),
  }));
}
