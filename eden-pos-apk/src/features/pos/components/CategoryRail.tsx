import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

type CategoryRailProps = {
  activeCategory: string;
  categories: string[];
  categoryColors: Record<string, string>;
  onReorderCategories(categories: string[]): void;
  onSelectCategory(category: string): void;
};

type CategoryButtonProps = {
  active: boolean;
  category: string;
  color: string;
  sortingActive: boolean;
  onSelect(category: string): void;
};

const LONG_PRESS_DELAY_MS = 420;
const SORTING_SETTLE_MS = 280;

const categoryColor = (color: string | undefined) =>
  color && color.trim() ? color : "#1A9345";

const SortableCategoryButton = ({
  active,
  category,
  color,
  onSelect,
  sortingActive
}: CategoryButtonProps) => {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition
  } = useSortable({ id: category });
  const style = {
    "--category-color": categoryColor(color),
    transform: CSS.Transform.toString(transform),
    transition
  } as CSSProperties;
  const { role: _sortableRole, ...sortableAttributes } = attributes;

  return (
    <button
      aria-selected={active}
      className={[
        "category-tab-button",
        active ? "active" : "",
        isDragging ? "dragging" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => {
        if (!sortingActive && !isDragging) {
          onSelect(category);
        }
      }}
      ref={setNodeRef}
      role="tab"
      style={style}
      title="กดค้างแล้วลากเพื่อเรียงลำดับ"
      type="button"
      {...sortableAttributes}
      {...listeners}
    >
      <span className="category-dot" aria-hidden="true" />
      <span className="category-label">{category}</span>
      <GripVertical
        aria-hidden="true"
        className="category-drag-icon"
        size={16}
      />
    </button>
  );
};

export const CategoryRail = ({
  activeCategory,
  categories,
  categoryColors,
  onReorderCategories,
  onSelectCategory
}: CategoryRailProps) => {
  const [sortingActive, setSortingActive] = useState(false);
  const settleTimer = useRef<number | null>(null);
  const lockedCategory = categories[0];
  const sortableCategories = categories.slice(1);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: LONG_PRESS_DELAY_MS,
        tolerance: 8
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  useEffect(
    () => () => {
      if (settleTimer.current) {
        window.clearTimeout(settleTimer.current);
      }
    },
    []
  );

  const settleSorting = () => {
    if (settleTimer.current) {
      window.clearTimeout(settleTimer.current);
    }

    settleTimer.current = window.setTimeout(() => {
      setSortingActive(false);
    }, SORTING_SETTLE_MS);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = sortableCategories.indexOf(String(active.id));
      const newIndex = sortableCategories.indexOf(String(over.id));

      if (oldIndex >= 0 && newIndex >= 0) {
        onReorderCategories([
          lockedCategory,
          ...arrayMove(sortableCategories, oldIndex, newIndex)
        ]);
      }
    }

    settleSorting();
  };

  if (!categories.length) {
    return null;
  }

  return (
    <div
      aria-label="หมวดหมู่สินค้า"
      className={[
        "category-tabs",
        "bottom-category-tabs",
        "category-rail",
        sortingActive ? "is-sorting" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      role="tablist"
    >
      <button
        aria-selected={activeCategory === lockedCategory}
        className={[
          "category-tab-button",
          "locked",
          activeCategory === lockedCategory ? "active" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => onSelectCategory(lockedCategory)}
        role="tab"
        style={
          {
            "--category-color": categoryColor(categoryColors[lockedCategory])
          } as CSSProperties
        }
        type="button"
      >
        <span className="category-dot" aria-hidden="true" />
        <span className="category-label">{lockedCategory}</span>
      </button>

      <DndContext
        collisionDetection={closestCenter}
        onDragCancel={settleSorting}
        onDragEnd={handleDragEnd}
        onDragStart={() => setSortingActive(true)}
        sensors={sensors}
      >
        <SortableContext
          items={sortableCategories}
          strategy={horizontalListSortingStrategy}
        >
          {sortableCategories.map((category) => (
            <SortableCategoryButton
              active={activeCategory === category}
              category={category}
              color={categoryColors[category]}
              key={category}
              onSelect={onSelectCategory}
              sortingActive={sortingActive}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
};
