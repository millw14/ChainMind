import { ConsoleHeader } from "@/components/console/ConsoleHeader";

export const metadata = {
  title: "Coordination investigation",
};

export default function AppShellLayout({ children }) {
  return (
    <div className="min-h-screen bg-cm-bg">
      <ConsoleHeader />
      {children}
    </div>
  );
}
