import { ConsoleHeader } from "@/components/console/ConsoleHeader";

export const metadata = {
  title: "Console",
};

export default function AppShellLayout({ children }) {
  return (
    <div className="min-h-screen bg-cm-bg">
      <ConsoleHeader />
      {children}
    </div>
  );
}
