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
  Receipt,
  Settings,
  Tags,
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
      {
        href: '/analytics',
        label: 'Spending analytics',
        icon: ChartNoAxesCombined,
      },
      { href: '/review', label: 'Review', icon: ListChecks },
      { href: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
      { href: '/receipts', label: 'Receipts', icon: Receipt },
      { href: '/cash', label: 'Cash', icon: Banknote },
    ],
  },
  {
    label: 'Setup',
    items: [
      { href: '/categories', label: 'Categories & rules', icon: Tags },
      { href: '/accounts', label: 'Accounts & exclusions', icon: Wallet },
      { href: '/connections', label: 'Bank connections', icon: Landmark },
      { href: '/fx', label: 'Currency conversion', icon: Coins },
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

/** The four screens on the phone's tab bar; the fifth tab opens everything. */
export const tabScreens = screenGroups[0]!.items.slice(0, 4);

export function visibleGroups(isAdmin: boolean): ScreenGroup[] {
  return screenGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.admin || isAdmin),
  }));
}
