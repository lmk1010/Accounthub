/**
 * 自定义下拉框组件
 */
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './CustomSelect.css';

export default function CustomSelect({
  value,
  onChange,
  options = [],
  placeholder = '请选择',
  disabled = false,
  size = 'default', // 'small' | 'default'
  className = '',
  searchable = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [dropdownStyle, setDropdownStyle] = useState({});
  const containerRef = useRef(null);
  const searchRef = useRef(null);

  const selectedOption = options.find(opt => opt.value === value);

  const filteredOptions = useMemo(() => {
    if (!searchable || !search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(opt => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q));
  }, [options, search, searchable]);

  const updateDropdownPosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setDropdownStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
    });
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        // 也检查 portal dropdown 内的点击
        const dropdown = document.querySelector('.custom-select-dropdown-portal');
        if (dropdown && dropdown.contains(e.target)) return;
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      if (searchable && searchRef.current) {
        searchRef.current.focus();
      }
    }
  }, [isOpen, searchable, updateDropdownPosition]);

  // 滚动/resize 时更新位置
  useEffect(() => {
    if (!isOpen) return;
    const onScrollOrResize = () => updateDropdownPosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [isOpen, updateDropdownPosition]);

  const handleSelect = (optValue) => {
    onChange?.(optValue);
    setIsOpen(false);
    setSearch('');
  };

  const dropdown = isOpen ? createPortal(
    <div className={`custom-select-dropdown custom-select-dropdown-portal ${size}`} style={dropdownStyle}>
      {searchable && (
        <div className="custom-select-search">
          <input
            ref={searchRef}
            type="text"
            className="custom-select-search-input"
            placeholder="搜索..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
      <div className="custom-select-options">
        {filteredOptions.length === 0 && (
          <div className="custom-select-empty">无匹配项</div>
        )}
        {filteredOptions.map((opt) => (
          <div
            key={opt.value}
            className={`custom-select-option ${opt.value === value ? 'selected' : ''}`}
            onClick={() => handleSelect(opt.value)}
          >
            {opt.value === value && <i className="fas fa-check" />}
            <span>{opt.label}</span>
          </div>
        ))}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div
      ref={containerRef}
      className={`custom-select ${size} ${isOpen ? 'open' : ''} ${disabled ? 'disabled' : ''} ${className}`}
    >
      <div className="custom-select-trigger" onClick={() => !disabled && setIsOpen(!isOpen)}>
        <span className="custom-select-value">
          {selectedOption?.label || placeholder}
        </span>
        <i className={`fas fa-chevron-down custom-select-arrow ${isOpen ? 'rotated' : ''}`} />
      </div>
      {dropdown}
    </div>
  );
}
