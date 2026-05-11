import { ConsoleHeader } from "@/components/console/ConsoleHeader";

export const metadata = {
  title: "Console",
};

export default function AppShellLayout({ children }) {
  return (
    <div className="min-h-screen bg-zinc-950">
      <ConsoleHeader />
      {children}
    </div>
  );
}
