/** The sections of My Picture. Shared by the server page (reads `?tab=`) and the client component. Spending patterns live on Analytics. */
export type PictureTab = "accounts" | "bills" | "activity";
export const PICTURE_TABS: { value: PictureTab; label: string }[] = [
  { value: "accounts", label: "Accounts" },
  { value: "bills", label: "Bills" },
  { value: "activity", label: "Activity" },
];
export const parsePictureTab = (v: string | undefined): PictureTab => (v === "bills" || v === "activity" ? v : "accounts");
