/** The three sections of My Picture. Shared by the server page (reads `?tab=`) and the client component. */
export type PictureTab = "accounts" | "bills" | "spending";
export const PICTURE_TABS: { value: PictureTab; label: string }[] = [
  { value: "accounts", label: "Accounts" },
  { value: "bills", label: "Bills" },
  { value: "spending", label: "Spending" },
];
export const parsePictureTab = (v: string | undefined): PictureTab => (v === "bills" || v === "spending" ? v : "accounts");
