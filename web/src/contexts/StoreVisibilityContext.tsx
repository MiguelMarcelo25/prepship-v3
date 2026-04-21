// @ts-nocheck
import { createContext, useContext, useState, ReactNode } from "react";

interface StoreVisibilityContextType {
  visibleStores: Set<string>;
  toggleStore: (storeId: string) => void;
  setVisibleStores: (stores: Set<string>) => void;
}

const StoreVisibilityContext = createContext<StoreVisibilityContextType | undefined>(undefined);

export function StoreVisibilityProvider({ children }: { children: ReactNode }) {
  const [visibleStores, setVisibleStores] = useState<Set<string>>(new Set());

  const toggleStore = (storeId: string) => {
    setVisibleStores((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(storeId)) {
        newSet.delete(storeId);
      } else {
        newSet.add(storeId);
      }
      return newSet;
    });
  };

  return (
    <StoreVisibilityContext.Provider value={{ visibleStores, toggleStore, setVisibleStores }}>
      {children}
    </StoreVisibilityContext.Provider>
  );
}

export function useStoreVisibility() {
  const context = useContext(StoreVisibilityContext);
  if (!context) {
    throw new Error("useStoreVisibility must be used within StoreVisibilityProvider");
  }
  return context;
}
