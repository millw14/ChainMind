import { ConsoleHeader } from "@/components/console/ConsoleHeader";

export const metadata = {
  title: "Robinhood Chain — AI explorer",
};

export default function AppShellLayout({ children }) {
  return (
    <div className="cm-scanlines min-h-screen bg-cm-bg">
      <ConsoleHeader />
      {children}
    </div>
  );
}
